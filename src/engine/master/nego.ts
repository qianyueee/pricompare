import { KK_COL, KK_VENDOR_SLOT_HEADERS } from '../export/kkLayout'
import { cleanAmountString } from './clean'
import { isDataRow, type MasterCell, type MasterData } from './model'

/**
 * NEGO 谈判比价（参照用户汇总表的 NEGO sheet）：
 * 选定若干行（零件×数量档），并排各家单价、最低单价、按下单数量算各家总额与最优组合总额，
 * 用于谈"全给某家 vs 最优拆分"的差价。
 */

const VENDOR_SLOTS = [8, 9, 10, 11, 12, 13] as const

const normPn = (v: MasterCell | string): string => String(v ?? '').trim().toUpperCase()

function cellNum(v: MasterCell | undefined): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  return cleanAmountString(v)
}

function cellStr(v: MasterCell | undefined): string {
  return v === null || v === undefined ? '' : String(v)
}

/** 金额乘积消除二进制浮点噪声（56.7×10 → 567 而非 567.000…01） */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6

export interface PnTier {
  qty: number | null
  rowIndex: number
  excelRow: number
  batch: string
}

/**
 * 某 P/N 在总表里的有效数量档：同一数量多次询价取最靠下（最近）一行；按数量升序。
 * 供界面显示 "几/几/几" 提示。
 */
export function pnTiers(master: MasterData, pn: string): PnTier[] {
  const target = normPn(pn)
  if (!target) return []
  const byQty = new Map<string, PnTier>()
  master.rows.forEach((row, rowIndex) => {
    if (!isDataRow(row)) return
    if (normPn(row.cells[KK_COL.pn]) !== target) return
    const qty = cellNum(row.cells[KK_COL.qty])
    const key = qty === null ? '?' : String(qty)
    // 靠后的行覆盖靠前的（最近一次询价优先）
    byQty.set(key, { qty, rowIndex, excelRow: rowIndex + 2, batch: cellStr(row.cells[KK_COL.name]) })
  })
  return [...byQty.values()].sort((a, b) => (a.qty ?? Infinity) - (b.qty ?? Infinity))
}

export interface NegoLine {
  rowIndex: number
  pn: string
  rev: string
  description: string
  /** 下单数量（可与来源档位不同，总价按它算） */
  qty: number | null
  /** 各供应商槽位（8..13）的单价；TDB/文字/空 → null */
  unit: Record<number, number | null>
}

export function buildNegoLine(master: MasterData, rowIndex: number, qtyOverride?: number | null): NegoLine {
  const row = master.rows[rowIndex]
  const cells = row?.cells ?? []
  const unit: Record<number, number | null> = {}
  for (const slot of VENDOR_SLOTS) unit[slot] = cellNum(cells[slot])
  return {
    rowIndex,
    pn: cellStr(cells[KK_COL.pn]),
    rev: cellStr(cells[KK_COL.rev]),
    description: cellStr(cells[KK_COL.description]),
    qty: qtyOverride !== undefined ? qtyOverride : cellNum(cells[KK_COL.qty]),
    unit,
  }
}

export interface PnResolution {
  /** 该 P/N 在总表的全部数量档（空数组 = 未找到） */
  tiers: PnTier[]
  /** 实际取价的档位（qty 未填或未找到 → null） */
  usedTier: PnTier | null
  /** 解析出的比价行（总价按输入 qty 计算）；无法取价 → null */
  line: NegoLine | null
}

/**
 * 比价页自由输入解析：给定 P/N 与下单数量，找到取价档位。
 * qty 精确命中某档 → 该档；否则按阶梯语义取 ≤qty 的最大档；比最小档还小 → 最小档；
 * qty 未填 → 只返回档位列表（界面在数量格中以 "1/3/6" 占位提示）。
 */
export function resolveNegoInput(master: MasterData, pn: string, qty: number | null): PnResolution {
  const tiers = pnTiers(master, pn)
  if (tiers.length === 0) return { tiers, usedTier: null, line: null }
  if (qty === null) return { tiers, usedTier: null, line: null }
  const numeric = tiers.filter((t): t is PnTier & { qty: number } => t.qty !== null)
  let used: PnTier | null = numeric.find((t) => t.qty === qty) ?? null
  if (!used && numeric.length > 0) {
    const below = numeric.filter((t) => t.qty <= qty)
    used = below.length > 0 ? below[below.length - 1]! : numeric[0]!
  }
  if (!used) used = tiers[0]! // 只有数量为空（'?'）的档
  return { tiers, usedTier: used, line: buildNegoLine(master, used.rowIndex, qty) }
}

/**
 * 比价页行按零件号合并：同一零件号（忽略大小写/首尾空白）只保留先出现的一行（含其数量），
 * 后面的重复丢弃；零件号为空的行（末尾空行 / 正在输入）原样保留。
 * 粘贴一列、Ctrl+B 选行、手输提交三条入口共用。
 */
export function dedupeNegoLinesByPn<T extends { pn: string; qty: number | null }>(lines: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const l of lines) {
    const key = normPn(l.pn)
    if (key === '') {
      out.push(l)
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    out.push(l)
  }
  return out
}

/**
 * 数量 Tab 继承：上一行输入数量后按 Tab，下一行该零件在总表里**恰有**这个数量档才继承，
 * 否则返回 null（留空让用户手填）。
 */
export function carryQtyFor(master: MasterData, pn: string, carry: number | null): number | null {
  if (carry === null) return null
  return pnTiers(master, pn).some((t) => t.qty === carry) ? carry : null
}

export interface NegoVendor {
  slot: number
  label: string
}

export interface NegoSummaryLine extends NegoLine {
  minUnit: number | null
  /** slot → 总价（单价×数量；缺单价或缺数量 → null） */
  totals: Record<number, number | null>
  optimalTotal: number | null
}

export interface NegoSummary {
  vendors: NegoVendor[]
  lines: NegoSummaryLine[]
  perVendor: { slot: number; label: string; sum: number; missing: number }[]
  optimalSum: number
}

export function buildNegoSummary(lines: NegoLine[]): NegoSummary {
  const usedSlots = VENDOR_SLOTS.filter((slot) => lines.some((l) => l.unit[slot] !== null))
  const vendors: NegoVendor[] = usedSlots.map((slot) => ({
    slot,
    label: KK_VENDOR_SLOT_HEADERS[slot - 8]!,
  }))
  const summaryLines: NegoSummaryLine[] = lines.map((l) => {
    const present = usedSlots.map((s) => l.unit[s]).filter((u): u is number => u !== null)
    const minUnit = present.length > 0 ? Math.min(...present) : null
    const totals: Record<number, number | null> = {}
    for (const slot of usedSlots) {
      const u = l.unit[slot]
      totals[slot] = u !== null && l.qty !== null ? round6(u * l.qty) : null
    }
    const optimalTotal = minUnit !== null && l.qty !== null ? round6(minUnit * l.qty) : null
    return { ...l, minUnit, totals, optimalTotal }
  })
  const perVendor = vendors.map(({ slot, label }) => {
    let sum = 0
    let missing = 0
    for (const l of summaryLines) {
      const t = l.totals[slot]
      if (t === null || t === undefined) missing++
      else sum += t
    }
    return { slot, label, sum: round6(sum), missing }
  })
  const optimalSum = round6(summaryLines.reduce((s, l) => s + (l.optimalTotal ?? 0), 0))
  return { vendors, lines: summaryLines, perVendor, optimalSum }
}

/** NEGO sheet 同构表格（表头 / 明细 / Total 合计行）：「复制为表格」与导出时写入 NEGO sheet 共用 */
export function negoTable(summary: NegoSummary): MasterCell[][] {
  const head: MasterCell[] = [
    'P/N',
    'Rev',
    'Description',
    "Q'ty",
    ...summary.vendors.map((v) => `${v.label} Unit`),
    'Min',
    ...summary.vendors.map((v) => `${v.label} Total`),
    'Optimal',
  ]
  const rows: MasterCell[][] = summary.lines.map((l) => [
    l.pn,
    l.rev,
    l.description,
    l.qty,
    ...summary.vendors.map((v) => l.unit[v.slot] ?? null),
    l.minUnit,
    ...summary.vendors.map((v) => l.totals[v.slot] ?? null),
    l.optimalTotal,
  ])
  const totalRow: MasterCell[] = [
    'Total', // 粘贴目标 NEGO sheet 为英文表，合计行不用中文
    null,
    null,
    null,
    ...summary.vendors.map(() => null),
    null,
    ...summary.perVendor.map((v) => v.sum),
    summary.optimalSum,
  ]
  return [head, ...rows, totalRow]
}

/** NEGO sheet 同构布局的 TSV（可直接粘贴进 Excel） */
export function negoToTsv(summary: NegoSummary): string {
  return negoTable(summary)
    .map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))).join('\t'))
    .join('\n')
}

/** 比价页输入（编号 + 下单数量）→ 汇总；未找到编号或数量未填的行不计入 */
export function negoSummaryFromInputs(master: MasterData, inputs: { pn: string; qty: number | null }[]): NegoSummary {
  const lines: NegoLine[] = []
  for (const it of inputs) {
    if (it.pn.trim() === '') continue
    const res = resolveNegoInput(master, it.pn, it.qty)
    if (res.line) lines.push(res.line)
  }
  return buildNegoSummary(lines)
}

export interface NegoSheetPlan {
  /** 是否找到了用户 NEGO sheet 自己的表头行（含 P/N 与 Q'ty 的行） */
  headerFound: boolean
  /** 0 基：找到表头时为表头行（明细从下一行起）；否则为我们写入表头的行 */
  startRow: number
  startCol: number
  /** 0 基 (行 → 列 → 值)，null = 清空旧内容 */
  writes: Map<number, Map<number, MasterCell>>
  lineCount: number
}

const isBlank = (v: MasterCell | undefined): boolean => v === null || v === undefined || String(v).trim() === ''

/** 表头文字归一化：去括号内容/空格/标点、小写，并归并常见同义写法（Q'ty≈Qty≈Quantity、P/N≈PN） */
function canonHeader(v: MasterCell | undefined): string {
  let k = String(v ?? '')
    .toLowerCase()
    .replace(/[（(][^)）]*[)）]/g, '')
    .replace(/[\s'’"`.,_\-/\\:：]/g, '')
  if (k === 'quantity' || k === 'qty' || k === 'quan') k = 'qty'
  if (k === 'partnumber' || k === 'partno' || k === 'pn' || k === '零件号' || k === '编号') k = 'pn'
  if (k === 'desc') k = 'description'
  if (k === 'minimum' || k === 'lowest') k = 'min'
  if (k === 'best') k = 'optimal'
  return k
}

/**
 * 导出总表时把比价内容写进 NEGO sheet：
 * - 找到 sheet 里含 P/N 与 Q'ty 的表头行 → 明细从其下一行起，**按表头文字对齐列**
 *   （HC Unit / SKW Total 等各归各列；表头里没有的列追加在末尾并补上表头文字），不动用户已有的表头；
 * - 找不到 → 从最后一个非空行之后（至少第 3 行，保留标题区）起连表头一起写；
 * - 旧明细（表头下 P/N 列连续非空块，含 Total 行）在表头宽度内整体清空后重写，表格下方的备注/页脚不动；\n *   与现值一致的格不动（用户自己写的公式若结果一致也保留）。
 */
export function planNegoSheetWrite(grid: MasterCell[][], summary: NegoSummary): NegoSheetPlan {
  const table = negoTable(summary)
  const head = table[0]!
  let headerRow = -1
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? []
    if (!row.some((v) => canonHeader(v) === 'pn')) continue
    if (!row.some((v) => canonHeader(v) === 'qty')) continue
    headerRow = r
    break
  }
  let dataStart: number
  let body: MasterCell[][]
  /** 我们表格第 i 列 → sheet 列 */
  let colFor: number[]
  let spanStart: number
  let spanEnd: number
  const writes = new Map<number, Map<number, MasterCell>>()
  const set = (r: number, c: number, v: MasterCell) => {
    let m = writes.get(r)
    if (!m) {
      m = new Map()
      writes.set(r, m)
    }
    m.set(c, v)
  }
  if (headerRow >= 0) {
    const hdr = grid[headerRow] ?? []
    const sheetCols = new Map<string, number>()
    let lastHeaderCol = -1
    hdr.forEach((v, c) => {
      if (isBlank(v)) return
      lastHeaderCol = c
      const key = canonHeader(v)
      if (!sheetCols.has(key)) sheetCols.set(key, c)
    })
    colFor = head.map((label) => {
      const key = canonHeader(label)
      const c = sheetCols.get(key)
      if (c !== undefined) return c
      lastHeaderCol += 1
      sheetCols.set(key, lastHeaderCol)
      set(headerRow, lastHeaderCol, label) // 表头里没有的列：追加并补表头文字
      return lastHeaderCol
    })
    spanStart = Math.min(...colFor, sheetCols.get('pn')!)
    spanEnd = lastHeaderCol
    dataStart = headerRow + 1
    body = table.slice(1)
  } else {
    let last = -1
    grid.forEach((row, r) => {
      if (row.some((v) => !isBlank(v))) last = r
    })
    dataStart = Math.max(2, last + 1)
    body = table
    colFor = head.map((_, i) => i)
    spanStart = 0
    spanEnd = head.length - 1
  }
  // 旧明细范围：表头下 P/N 列连续非空的块（含结尾的 Total 行）；再往下的备注/页脚不动
  let oldEnd = dataStart - 1
  for (let r = dataStart; r < grid.length; r++) {
    const pnCell = grid[r]?.[colFor[0]!]
    if (isBlank(pnCell)) break
    oldEnd = r
    if (canonHeader(pnCell) === 'total') break
  }
  const newEnd = dataStart + body.length - 1
  for (let r = dataStart; r <= Math.max(newEnd, oldEnd); r++) {
    const src = body[r - dataStart]
    const target = new Map<number, MasterCell>()
    for (let c = spanStart; c <= spanEnd; c++) target.set(c, null)
    if (src) colFor.forEach((c, i) => target.set(c, src[i] ?? null))
    for (const [c, v] of target) {
      const oldRaw = grid[r]?.[c]
      const old: MasterCell = isBlank(oldRaw) ? null : (oldRaw as MasterCell)
      if (old === v) continue
      if (typeof old === 'number' && typeof v === 'number' && Math.abs(old - v) < 1e-9) continue
      if (old !== null && v !== null && String(old) === String(v)) continue
      set(r, c, v)
    }
  }
  return {
    headerFound: headerRow >= 0,
    startRow: headerRow >= 0 ? headerRow : dataStart,
    startCol: spanStart,
    writes,
    lineCount: summary.lines.length,
  }
}
