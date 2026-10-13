// pricompare 命令行（逻辑；入口是 cli.ts）：给每小时的自动导入和手工维护用，经本机服务改总表（排队、记历史、网页实时刷新）。
// 并入规则和桌面版「并入」完全相同（同一套引擎）；所有改动都发给服务，服务按顺序应用。
// 环境变量 PRICOMPARE_URL 可改服务地址，默认 http://127.0.0.1:8790；--source 标记历史里的来源（默认 cli）。
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import * as XLSX from 'xlsx'
import { analyzeSheet } from '../engine/analyze'
import { KK_COL, KK_VENDOR_COLS } from '../engine/export/kkLayout'
import { cleanAmountString, cleanMasterAmounts } from '../engine/master/clean'
import { planMerge, type MergeOptions, type MergePlan } from '../engine/master/merge'
import { isDataRow, isPlaceholderRow, parseMasterWorkbook, type MasterCell, type MasterData } from '../engine/master/model'
import type { CellChange, MasterOp } from '../engine/master/ops'
import { parseLeadTime } from '../engine/normalize/leadtime'
import { parsePrice } from '../engine/normalize/price'
import type { AnalyzedSheet, ColumnMapping, Currency, FieldKey, QuoteRow } from '../engine/types'
import { colLetter, letterToIdx } from '../engine/util'
import { SEED_VENDORS, migrateVendorRegistry, type Vendor } from '../engine/vendor'
import { readWorkbook, sheetGrid } from '../engine/workbook'
import {
  CLIENT_HEADER,
  type HistoryEntry,
  type ImportMasterRequest,
  type MasterSnapshot,
  type PostOpResponse,
  type ServerSession,
} from '../shared/serverApi'
import { hashPassword } from './password'

const HELP = `用法：node cli.mjs <命令> [参数]

  status                                   服务、总表版本和最近 10 次改动
  history [--limit N]                      最近的改动记录
  import-master <汇总表.xlsm>               整表导入（替换当前总表并保存原件作导出底版）
  dump <文件.xlsx> [--sheet S] [--limit N]  逐格打印报价单（每个 sheet，标出隐藏列/隐藏行），看清原表用
  analyze <报价.xlsx> [识别参数]             按桌面版规则识别报价单，输出 JSON（不改总表）
  preview <报价.xlsx> --vendor V --batch B [识别参数]
                                           预演并入：哪些行填价、新增、修订、跳过（不改总表）
  merge <报价.xlsx> --vendor V --batch B [识别参数]
                                           并入总表（规则同桌面版「并入」）
  merge-rows --rows <rows.json> --vendor V --batch B [--dry-run]
                                           并入正文里的报价（没有附件时，把行写成 JSON）
  batches [--last N]                       最近的询价组：行号范围、各家已填几行
  rows [--batch B] [--pn P] [--last N] [--json]
                                           查总表行（Excel 行号、各家价格、单号、交期、备注）
  set --row R --col C --value V [--expect-pn P] [--append] [--text]
  set --cells <cells.json>                 改格：R 是 Excel 行号，C 是列字母；--append 追加（备注用「; 」连接）
  hash-password                            从标准输入读密码，输出填进 config.json「password」的哈希（不连服务）

识别参数：--sheet 名称  --header-row N（Excel 行号）  --price-col 列字母  --map 字段=列字母,…
          （字段：pn rev qty price leadTime quoteNo item description material surfaceFinish
            cleaningSpec process size remark quoteEa name；ignore 表示不取该列）
          报价单里的隐藏列当不存在：识别出的单价列若是隐藏列，自动改用最像单价的可见列（见 warnings）。
供应商 V：注册表里的 id 或名称（hc、skw、cl…）；不在注册表里的一律拒绝，先问人。
rows.json：[{"pn","rev","qty","price","currency","lead","quoteNo","item","description","material",
            "surfaceFinish","cleaningSpec","process","size","remark","quoteEa"}]，price 可为数字或原文
cells.json：[{"row":1723,"col":"K","value":"无","expectPn":"0100001-001","append":false}]
`

const OPTIONS = {
  url: { type: 'string' },
  source: { type: 'string', default: 'cli' },
  vendor: { type: 'string' },
  batch: { type: 'string' },
  sheet: { type: 'string' },
  'header-row': { type: 'string' },
  'price-col': { type: 'string' },
  map: { type: 'string' },
  rows: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  pn: { type: 'string' },
  last: { type: 'string' },
  limit: { type: 'string' },
  json: { type: 'boolean', default: false },
  row: { type: 'string' },
  col: { type: 'string' },
  value: { type: 'string' },
  'expect-pn': { type: 'string' },
  append: { type: 'boolean', default: false },
  text: { type: 'boolean', default: false },
  cells: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
} as const

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values']

// 一次 runCli 的参数与输出（命令行进程里只跑一次；测试里逐条调用）
let values: Values
let base = ''
let out: (s: string) => void = (s) => process.stdout.write(`${s}\n`)

class CliError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1', 'x-pri-source': values.source! },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((err: unknown) => {
    throw new CliError(`连不上 pricompare 服务（${base}）：${err instanceof Error ? err.message : String(err)}`)
  })
  const json = (await res.json()) as T & { error?: string }
  if (!res.ok && res.status !== 409) throw new CliError(json.error ?? `HTTP ${res.status}`)
  return json
}

const excelRow = (idx: number) => idx + 2
const text = (v: MasterCell | undefined) => (v === null || v === undefined ? '' : String(v))

/* ---------------- 上下文：总表、供应商注册表、映射模板 ---------------- */

interface Template {
  sheetName: string
  mapping: ColumnMapping
  vendorId: string
  vendorDisplay: string
}

async function registry(): Promise<Vendor[]> {
  const saved = await call<Vendor[] | null>('GET', '/api/store/vendorRegistry')
  return Array.isArray(saved) && saved.length > 0 ? migrateVendorRegistry(saved).registry : SEED_VENDORS
}

function resolveVendor(reg: Vendor[], name: string | undefined): Vendor & { slot: number } {
  if (!name) throw new CliError('缺少 --vendor')
  const n = name.trim().toLowerCase()
  const v = reg.find(
    (x) => x.id === n || x.display.toLowerCase() === n || x.aliases.some((a) => a.toLowerCase() === n),
  )
  if (!v) throw new CliError(`供应商「${name}」不在注册表里（已有：${reg.map((x) => `${x.id}/${x.display}`).join('、')}），先问人记哪一列`)
  if (!v.kkSlot) throw new CliError(`供应商「${v.display}」没有对应的汇总表列`)
  return { ...v, slot: letterToIdx(v.kkSlot) }
}

/* ---------------- 识别报价单 ---------------- */

const FIELDS = new Set<FieldKey>([
  'pn', 'rev', 'qty', 'price', 'leadTime', 'quoteNo', 'item', 'description', 'material', 'surfaceFinish',
  'cleaningSpec', 'process', 'size', 'remark', 'quoteEa', 'name', 'ignore',
])

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/** 各 sheet 被隐藏的列和行（供应商模板常把残留旧价藏起来：华臣 H 列 Quote(each)、凯维 I 列 Mao） */
function hiddenParts(buf: Buffer, rows = false): Map<string, { cols: number[]; rows: number[] }> {
  const wb = XLSX.read(buf, { type: 'buffer', cellStyles: true, ...(rows ? {} : { sheetRows: 1 }) })
  const res = new Map<string, { cols: number[]; rows: number[] }>()
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    res.set(name, {
      cols: (ws?.['!cols'] ?? []).flatMap((c, i) => (c?.hidden ? [i] : [])),
      rows: rows ? (ws?.['!rows'] ?? []).flatMap((r, i) => (r?.hidden ? [i] : [])) : [],
    })
  }
  return res
}

interface Analyzed {
  file: string
  analysis: AnalyzedSheet
  hidden: number[]
  templateUsed: boolean
  notes: string[]
}

async function analyzeFile(file: string, reg: Vendor[]): Promise<Analyzed> {
  const buf = await readFile(file)
  const pw = readWorkbook(toArrayBuffer(buf))
  const hiddenBySheet = hiddenParts(buf)
  const fileName = basename(file)
  const headerRow = values['header-row'] ? Number(values['header-row']) - 1 : undefined
  const first = await analyzeSheet(pw, { fileName, vendors: reg, sheetName: values.sheet, forcedHeaderRow: headerRow })
  let sheetName = first.sheetName
  let mapping: ColumnMapping | null = null
  let templateUsed = false
  const notes: string[] = []
  const templates = (await call<Record<string, Template> | null>('GET', '/api/store/mappingTemplates')) ?? {}
  const tpl = templates[first.fingerprint]
  if (tpl && !values.sheet && headerRow === undefined) {
    mapping = structuredClone(tpl.mapping)
    sheetName = tpl.sheetName
    templateUsed = true
  }

  // 隐藏列当不存在：映射到隐藏列的字段丢掉；单价列是隐藏列时改用最像单价的可见列
  const hidden = hiddenBySheet.get(sheetName)?.cols ?? []
  const current = mapping ?? first.mapping
  const hiddenFields = Object.entries(current.map).filter(([c, f]) => f !== 'ignore' && hidden.includes(Number(c)))
  if (hiddenFields.length > 0) {
    mapping = structuredClone(current)
    for (const [c, f] of hiddenFields) {
      delete mapping.map[Number(c)]
      if (f !== 'price') notes.push(`${colLetter(Number(c))} 列是隐藏列，不取「${f}」`)
    }
    if (hidden.includes(mapping.priceCol)) {
      const alt = first.candidates.find((c) => !hidden.includes(c.col))
      notes.push(
        alt
          ? `单价列 ${colLetter(mapping.priceCol)} 是隐藏列（常是残留旧价），已改用可见的 ${colLetter(alt.col)}「${alt.header.replace(/\s+/g, ' ').trim()}」`
          : `单价列 ${colLetter(mapping.priceCol)} 是隐藏列（常是残留旧价），没有别的可见单价列，请看原表后用 --price-col 指定`,
      )
      mapping.priceCol = alt?.col ?? -1
      if (alt) {
        mapping.map[alt.col] = 'price'
        mapping.priceCurrency = alt.currencyGuess
      }
    }
  }

  // 人工指定的列（--price-col / --map）最后生效
  if (values['price-col'] || values.map) {
    mapping = structuredClone(mapping ?? first.mapping)
    const setField = (field: FieldKey, letter: string) => {
      if (!/^[A-Z]{1,2}$/i.test(letter)) throw new CliError(`列字母不对：${letter}`)
      const col = letterToIdx(letter.toUpperCase())
      for (const [c, f] of Object.entries(mapping!.map)) if (f === field) delete mapping!.map[Number(c)]
      mapping!.map[col] = field
      if (field === 'price') mapping!.priceCol = col
      else if (mapping!.priceCol === col) mapping!.priceCol = -1
      if (hidden.includes(col)) notes.push(`按指定读取了隐藏列 ${colLetter(col)}（${field}）`)
    }
    if (values['price-col']) setField('price', values['price-col'])
    for (const pair of (values.map ?? '').split(',').filter(Boolean)) {
      const [field, letter] = pair.split('=').map((t) => t.trim())
      if (!field || !letter || !FIELDS.has(field as FieldKey)) {
        throw new CliError(`--map 写法不对：${pair}`)
      }
      setField(field as FieldKey, letter)
    }
  }

  const analysis = mapping
    ? await analyzeSheet(pw, { fileName, vendors: reg, sheetName, mappingOverride: mapping })
    : first
  return { file: fileName, analysis, hidden, templateUsed, notes }
}

function quoteJson(q: QuoteRow) {
  return {
    excelRow: q.sourceRow,
    pn: q.pn,
    rev: q.rev,
    qty: q.qty,
    price: q.price.status === 'ok' ? q.price.amount : null,
    priceRaw: q.price.raw,
    priceStatus: q.price.status,
    currency: q.price.currency,
    lead: q.leadTime.raw,
    quoteNo: q.quoteNo,
    item: q.item,
    description: q.description.slice(0, 80),
    material: q.material,
    surfaceFinish: q.surfaceFinish,
    cleaningSpec: q.cleaningSpec,
    process: q.process,
    size: q.size,
    remark: q.remark,
    quoteEa: q.quoteEa,
  }
}

function analysisJson(a: Analyzed, reg: Vendor[]) {
  const { analysis } = a
  const header = analysis.preview[analysis.headerRow] ?? []
  const label = (c: number) => `${colLetter(c)}「${text(header[c]?.v ?? null).replace(/\s+/g, ' ').trim()}」`
  const warnings = [...a.notes, ...analysis.warnings]
  if (analysis.mapping.priceCol < 0) warnings.unshift('没有识别出单价列，请用 dump 看原表后用 --price-col 指定')
  const guess = analysis.vendorGuess.vendorId ? reg.find((v) => v.id === analysis.vendorGuess.vendorId) : undefined
  return {
    file: a.file,
    sheet: analysis.sheetName,
    headerRow: analysis.headerRow + 1,
    needsManualHeader: analysis.needsManualHeader,
    templateUsed: a.templateUsed,
    priceColumn: analysis.mapping.priceCol >= 0 ? label(analysis.mapping.priceCol) : null,
    priceCurrency: analysis.mapping.priceCurrency,
    mapping: Object.fromEntries(
      Object.entries(analysis.mapping.map)
        .filter(([, f]) => f !== 'ignore')
        .map(([c, f]) => [f, label(Number(c))]),
    ),
    priceCandidates: analysis.candidates.slice(0, 4).map((c) => ({
      column: label(c.col),
      score: Math.round(c.score * 100) / 100,
      numeric: `${c.numericCount}/${c.rowCount}`,
      samples: c.sampleValues,
    })),
    hiddenColumns: a.hidden.map(colLetter),
    vendorGuess: guess ? { vendor: guess.display, evidence: analysis.vendorGuess.evidence } : null,
    warnings,
    rows: analysis.rows.map(quoteJson),
  }
}

/* ---------------- 并入 ---------------- */

const colName = (c: number) => {
  const v = KK_VENDOR_COLS.find((x) => x.col === c)
  return v ? `${colLetter(c)}(${v.header})` : colLetter(c)
}

function printPlan(plan: MergePlan, master: MasterData) {
  out(`更新 ${plan.fillCount} 行 · 新增 ${plan.appendCount} 行 · 修订 ${plan.reviseCount} 行 · 跳过 ${plan.skipCount} 行`)
  const kindName = { fill: '填价', append: '新增', revise: '修订', skip: '跳过' } as const
  for (const a of plan.actions) {
    const q = a.quote
    const batch = a.kind === 'append' ? '' : ` [${text(master.rows[a.rowIndex]?.cells[KK_COL.name])}]`
    const changes = a.changes
      .filter((ch) => ch.col !== KK_COL.no)
      .map((ch) => `${colName(ch.col)}: ${text(ch.from) || '空'} → ${text(ch.to) || '空'}`)
      .join('；')
    out(`  ${kindName[a.kind]} 第${a.excelRow}行${batch} ${q.pn} ×${q.qty ?? '?'}${changes ? `  ${changes}` : ''}`)
  }
  for (const w of plan.warnings) out(`  ⚠ ${w}`)
}

async function runMerge(quotes: QuoteRow[], vendor: Vendor & { slot: number }, dryRun: boolean) {
  const batch = values.batch?.trim()
  if (!batch) throw new CliError('缺少 --batch（询价组名，如「20261012 Ivan」，取自邮件主题）')
  if (quotes.length === 0) throw new CliError('没有可并入的报价行')
  const options: MergeOptions = { batch, vendorSlot: vendor.slot, vendorId: vendor.id, vendorDisplay: vendor.display }
  const snap = await call<MasterSnapshot>('GET', '/api/master')
  const master = snap.master ?? { rows: [], sheetName: 'KK询价汇总', passthrough: [], sourceFileName: null, importedAt: Date.now() }
  const plan = planMerge(master, quotes, options)
  out(`${dryRun ? '预演' : '并入'}：${vendor.display} → ${colName(vendor.slot)}，批次「${batch}」，总表版本 ${snap.version}`)
  printPlan(plan, master)
  if (dryRun) return
  const op: MasterOp = { kind: 'merge', quotes, options }
  const res = await call<PostOpResponse>('POST', '/api/ops', { baseVersion: snap.version, opId: crypto.randomUUID(), op })
  if (!res.applied) {
    out(res.reason === 'unchanged' ? '总表没有变化（全部已在表内）' : `服务拒绝：${res.reason}，请重试`)
    return
  }
  out(`已并入，总表版本 ${res.version}`)
  if (res.version !== snap.version + 1) out('（期间总表有别的改动，服务已在最新总表上按同样规则重新并入）')
}

interface RowInput {
  pn: string
  rev?: string
  qty?: number | null
  price?: number | string | null
  currency?: Currency
  lead?: string | number
  quoteNo?: string
  item?: string | number
  description?: string
  material?: string
  surfaceFinish?: string
  cleaningSpec?: string
  process?: string
  size?: string
  remark?: string
  quoteEa?: string | number
}

function rowToQuote(r: RowInput, i: number): QuoteRow {
  if (!r.pn || typeof r.pn !== 'string') throw new CliError(`第 ${i + 1} 行缺少 pn`)
  const cell = (v: string | number | null | undefined) =>
    v === null || v === undefined || v === '' ? undefined : { v, isError: false }
  return {
    pn: r.pn.trim(),
    rev: String(r.rev ?? '').replace(/\s+/g, '').toUpperCase(),
    qty: r.qty === undefined || r.qty === null ? null : Number(r.qty),
    price: parsePrice(cell(r.price), '', r.currency ?? 'RMB'),
    leadTime: parseLeadTime(cell(r.lead)),
    item: String(r.item ?? ''),
    quoteEa: String(r.quoteEa ?? ''),
    description: r.description ?? '',
    material: r.material ?? '',
    surfaceFinish: r.surfaceFinish ?? '',
    cleaningSpec: r.cleaningSpec ?? '',
    process: r.process ?? '',
    size: r.size ?? '',
    quoteNo: r.quoteNo ?? '',
    remark: r.remark ?? '',
    basePn: '',
    partType: '',
    sourceRow: i + 1,
  }
}

async function readJsonArg<T>(arg: string | undefined, what: string): Promise<T> {
  if (!arg) throw new CliError(`缺少 ${what}`)
  const raw = arg.trim().startsWith('[') ? arg : await readFile(arg, 'utf8')
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new CliError(`${what} 不是合法的 JSON`)
  }
}

/* ---------------- 查行 / 改格 ---------------- */

const ROW_COLS = [
  KK_COL.no, KK_COL.name, KK_COL.item, KK_COL.pn, KK_COL.rev, KK_COL.qty, KK_COL.quoteEach,
  ...KK_VENDOR_COLS.map((v) => v.col), KK_COL.quoteEa, KK_COL.quoteNo, KK_COL.leadTime, KK_COL.comment,
]

async function rows() {
  const snap = await call<MasterSnapshot>('GET', '/api/master')
  const all = (snap.master?.rows ?? []).map((row, index) => ({ row, index }))
  let picked = all.filter(({ row }) => isDataRow(row))
  if (values.batch) {
    const b = values.batch.trim().toLowerCase()
    picked = picked.filter(({ row }) => text(row.cells[KK_COL.name]).trim().toLowerCase().includes(b))
  }
  if (values.pn) {
    const p = values.pn.trim().toUpperCase()
    picked = picked.filter(({ row }) => text(row.cells[KK_COL.pn]).trim().toUpperCase().includes(p))
  }
  const last = Number(values.last ?? (values.batch || values.pn ? 0 : 20))
  if (last > 0) picked = picked.slice(-last)
  if (values.json) {
    out(
      JSON.stringify(
        picked.map(({ row, index }) => ({
          excelRow: excelRow(index),
          ...Object.fromEntries(ROW_COLS.map((c) => [colName(c), row.cells[c] ?? null])),
        })),
        null,
        1,
      ),
    )
    return
  }
  out(`总表版本 ${snap.version}，${picked.length} 行`)
  for (const { row, index } of picked) {
    const parts = ROW_COLS.map((c) => [c, row.cells[c]] as const)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([c, v]) => `${colName(c)}=${text(v)}`)
    out(`  第${excelRow(index)}行  ${parts.join(' | ')}`)
  }
}

interface CellInput {
  row: number
  col: string
  value: string | number | null
  expectPn?: string
  append?: boolean
}

function typedValue(v: string | number | null, col: number, asText: boolean): MasterCell {
  if (v === null || typeof v === 'number') return v
  const t = v.trim()
  if (t === '') return null
  if (asText) return v
  const amount = cleanAmountString(t)
  const isNumber = /^[-+]?[\d.,，]+$/.test(t)
  if (isNumber && amount !== null) return amount
  if (KK_VENDOR_COLS.some((x) => x.col === col) && amount !== null && /^[￥¥$]/.test(t)) return amount
  return v
}

async function setCells() {
  const inputs: CellInput[] = values.cells
    ? await readJsonArg<CellInput[]>(values.cells, '--cells')
    : [
        {
          row: Number(values.row),
          col: values.col ?? '',
          value: values.value ?? null,
          expectPn: values['expect-pn'],
          append: values.append,
        },
      ]
  const snap = await call<MasterSnapshot>('GET', '/api/master')
  const master = snap.master
  if (!master) throw new CliError('总表是空的')
  const changes: CellChange[] = []
  for (const inp of inputs) {
    const idx = Number(inp.row) - 2
    const col = letterToIdx(String(inp.col))
    const row = master.rows[idx]
    if (!Number.isInteger(idx) || !row) throw new CliError(`没有第 ${inp.row} 行`)
    if (col <= KK_COL.no || col >= row.cells.length + 1 || !/^[A-Z]{1,2}$/i.test(String(inp.col))) {
      throw new CliError(`列 ${inp.col} 不能改`)
    }
    const pn = text(row.cells[KK_COL.pn]).trim()
    if (inp.expectPn && pn.toUpperCase() !== inp.expectPn.trim().toUpperCase()) {
      throw new CliError(`第 ${inp.row} 行的 P/N 是「${pn}」，不是「${inp.expectPn}」，总表可能变了，先用 rows 重新查行号`)
    }
    let value = typedValue(inp.value, col, values.text ?? false)
    if (inp.append && value !== null) {
      const before = text(changes.find((c) => c.row === idx && c.col === col)?.value ?? row.cells[col]).trim()
      const add = String(value).trim()
      value = !before ? add : before.includes(add) ? before : `${before}; ${add}`
    }
    changes.push({ row: idx, col, value })
  }
  const op: MasterOp = { kind: 'setCells', cells: changes }
  const res = await call<PostOpResponse>('POST', '/api/ops', { baseVersion: snap.version, opId: crypto.randomUUID(), op })
  if (res.applied) out(`已改 ${res.changedCells} 格，总表版本 ${res.version}`)
  else if (res.reason === 'unchanged') out('没有变化（格子里已是这个值）')
  else throw new CliError('总表刚删过行，行号可能变了；先用 rows 重新查行号再改')
  for (const ch of changes) out(`  ${colName(ch.col)}${excelRow(ch.row)} = ${text(ch.value)}`)
}

/* ---------------- 看原表 / 询价组 ---------------- */

const clip = (t: string, n = 60) => (t.length > n ? `${t.slice(0, n)}…` : t)

async function dump(file: string | undefined) {
  if (!file) throw new CliError('用法：dump <文件.xlsx>')
  const buf = await readFile(file)
  const pw = readWorkbook(toArrayBuffer(buf))
  const hidden = hiddenParts(buf, true)
  const limit = Number(values.limit ?? 80)
  const sheets = values.sheet ? [values.sheet] : pw.sheetNames
  for (const name of sheets) {
    if (!pw.sheetNames.includes(name)) throw new CliError(`没有 sheet「${name}」（有：${pw.sheetNames.join('、')}）`)
    const h = hidden.get(name) ?? { cols: [], rows: [] }
    const grid = sheetGrid(pw, name)
    out(
      `== sheet「${name}」${grid.length} 行` +
        `；隐藏列：${h.cols.map(colLetter).join(' ') || '无'}；隐藏行：${h.rows.map((r) => r + 1).join(' ') || '无'}`,
    )
    let shown = 0
    for (let r = 0; r < grid.length && shown < limit; r++) {
      const parts: string[] = []
      ;(grid[r] ?? []).forEach((cell, c) => {
        if (!cell) return
        const v = cell.isError ? (cell.w ?? '#ERROR') : text(cell.v).replace(/\s+/g, ' ').trim()
        if (v === '') return
        parts.push(`${colLetter(c)}${h.cols.includes(c) ? '(隐)' : ''}=${clip(v)}`)
      })
      if (parts.length === 0) continue
      out(`  ${r + 1}${h.rows.includes(r) ? '(隐)' : ''}: ${parts.join(' | ')}`)
      shown++
    }
    if (shown >= limit) out(`  …（只显示前 ${limit} 个非空行，--limit 调整）`)
  }
}

async function batches() {
  const snap = await call<MasterSnapshot>('GET', '/api/master')
  const rowsAll = snap.master?.rows ?? []
  const groups: { name: string; first: number; last: number; count: number; filled: number[] }[] = []
  rowsAll.forEach((row, i) => {
    if (!isDataRow(row) || isPlaceholderRow(row)) return
    const name = text(row.cells[KK_COL.name]).trim()
    let g = groups[groups.length - 1]
    if (!g || g.name !== name) {
      g = { name, first: i, last: i, count: 0, filled: KK_VENDOR_COLS.map(() => 0) }
      groups.push(g)
    }
    g.last = i
    g.count++
    KK_VENDOR_COLS.forEach((v, k) => {
      const cell = row.cells[v.col]
      if (cell !== null && cell !== undefined && String(cell).trim() !== '') g!.filled[k]!++
    })
  })
  const last = Number(values.last ?? 15)
  out(`总表版本 ${snap.version}，共 ${groups.length} 个询价组，最近 ${Math.min(last, groups.length)} 个：`)
  for (const g of groups.slice(-last)) {
    const vendors = KK_VENDOR_COLS.map((v, k) => (g.filled[k] ? `${v.header} ${g.filled[k]}/${g.count}` : ''))
      .filter(Boolean)
      .join('，')
    out(`  「${g.name || '（无组名）'}」第${excelRow(g.first)}–${excelRow(g.last)}行 ${g.count} 行；已填：${vendors || '无'}`)
  }
}

/* ---------------- 其他命令 ---------------- */

async function importMaster(file: string | undefined): Promise<void> {
  if (!file) throw new CliError('用法：import-master <KK询价汇总表.xlsm>')
  const buf = await readFile(file)
  const parsed = parseMasterWorkbook(readWorkbook(toArrayBuffer(buf)), basename(file))
  if (!parsed) throw new CliError(`${basename(file)} 不是 KK 询价汇总表`)
  const { master, changed } = cleanMasterAmounts(parsed)
  const body: ImportMasterRequest = { master, file: { name: basename(file), b64: buf.toString('base64') } }
  const { version } = await call<{ version: number }>('POST', '/api/master/import', body)
  const count = master.rows.filter(isDataRow).length
  out(`已导入 ${basename(file)}：${count} 行数据，规范 ${changed} 个文本金额，总表版本 ${version}`)
}

async function history(limit: number): Promise<void> {
  const list = await call<HistoryEntry[]>('GET', `/api/history?limit=${limit}`)
  for (const h of list) out(`  v${h.version}  ${h.at}  ${h.user}/${h.source}  ${h.summary}`)
}

async function status(): Promise<void> {
  const session = await call<ServerSession>('GET', '/api/session')
  const snap = await call<MasterSnapshot>('GET', '/api/master')
  const count = snap.master?.rows.filter(isDataRow).length ?? 0
  out(`服务 ${base} · 身份 ${session.user}（${session.role}）· 总表版本 ${snap.version} · ${count} 行数据`)
  await history(10)
}

/** 跑一条命令，返回退出码（0 成功，1 出错，2 用法不对） */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function runCli(
  argv: string[],
  io: {
    out?: (s: string) => void
    err?: (s: string) => void
    env?: NodeJS.ProcessEnv
    stdin?: () => Promise<string>
  } = {},
): Promise<number> {
  out = io.out ?? ((s) => process.stdout.write(`${s}\n`))
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`))
  const env = io.env ?? process.env
  try {
    const parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS })
    values = parsed.values
    base = (values.url ?? env.PRICOMPARE_URL ?? 'http://127.0.0.1:8790').replace(/\/$/, '')
    const [cmd, ...rest] = parsed.positionals
    if (values.help || !cmd) out(HELP)
    else if (cmd === 'import-master') await importMaster(rest[0])
    else if (cmd === 'status') await status()
    else if (cmd === 'history') await history(Number(values.limit ?? 30))
    else if (cmd === 'dump') await dump(rest[0])
    else if (cmd === 'analyze' || cmd === 'preview' || cmd === 'merge') {
      if (!rest[0]) throw new CliError(`用法：${cmd} <报价.xlsx>`)
      const reg = await registry()
      const a = await analyzeFile(rest[0], reg)
      const info = analysisJson(a, reg)
      if (cmd === 'analyze') out(JSON.stringify(info, null, 1))
      else {
        out(`${info.file}：sheet「${info.sheet}」表头第 ${info.headerRow} 行，单价列 ${info.priceColumn ?? '未识别'}，${info.rows.length} 行报价`)
        for (const w of info.warnings) out(`  ⚠ ${w}`)
        // 桌面版这两种情况会停在映射确认框；无人值守时不猜，要人（或 claude）先看原表再指定
        if (a.analysis.mapping.priceCol < 0) throw new CliError('没有识别出单价列：先 dump 看原表，再用 --price-col 指定')
        if (a.analysis.needsManualHeader && !values['header-row'] && !a.templateUsed) {
          throw new CliError('表头行没认准：先 dump 看原表，再用 --header-row 指定')
        }
        await runMerge(a.analysis.rows, resolveVendor(reg, values.vendor), cmd === 'preview')
      }
    } else if (cmd === 'merge-rows') {
      const reg = await registry()
      const vendor = resolveVendor(reg, values.vendor)
      const input = await readJsonArg<RowInput[]>(values.rows, '--rows')
      if (!Array.isArray(input)) throw new CliError('--rows 应是数组')
      await runMerge(input.map(rowToQuote), vendor, values['dry-run'] ?? false)
    } else if (cmd === 'batches') await batches()
    else if (cmd === 'rows') await rows()
    else if (cmd === 'set') await setCells()
    else if (cmd === 'hash-password') {
      const password = (await (io.stdin ?? readStdin)()).replace(/\r?\n$/, '')
      if (!password) throw new CliError('没读到密码：用法 printf %s 密码 | node cli.mjs hash-password')
      out(await hashPassword(password))
    }
    else {
      out(HELP)
      return 2
    }
    return 0
  } catch (e) {
    err(e instanceof Error ? e.message : String(e))
    return 1
  }
}
