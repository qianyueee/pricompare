/**
 * 导出时把工作簿的 NEGO sheet 重建为「活表」：与比价页同一套逻辑的 Excel 公式表——
 * 在表格里输入零件号 + 数量，Rev / 描述 / 各家单价（按数量档、阶梯取档）/ 最低 / 各家总额 /
 * 最优 / 状态 / 数量档列表全部由公式算出，表格上方是各家合计与最优合计；比价页当前的行预填进去。
 *
 * 参照用户自建的 NEGO v2（工作簿名称 MPN / MQTY / MROW + 末尾 Src Row 辅助列 + 表格计算列），
 * 补上比价页的阶梯取档（不在档上取 ≤数量 的最大档，比最小档还小取最小档）与多供应商列。
 * 公式全部按 CSE 数组公式（<f t="array">）写入，老版 Excel 也按数组求值；
 * 数量档列表用到 FILTER / SORT / UNIQUE（Excel 365）。
 */
import { colLetter } from '../util'
import { cleanAmountString } from './clean'
import { isDataRow, type MasterCell, type MasterData } from './model'
import { pnTiers } from './nego'

export interface NegoInput {
  pn: string
  qty: number | null
}

export interface NegoSheetVendor {
  /** 汇总表物理列（0 基） */
  col: number
  label: string
}

/** 预填行：与 Excel 公式同一套逻辑在本地算好的缓存值（Excel 打开时会按 fullCalcOnLoad 重算一遍） */
export interface NegoSheetRow {
  pn: string
  qty: number | null
  rev: string
  description: string
  /** 实际取价的数量档（无 → null） */
  tier: number | null
  /** 取价行的 Excel 行号（无 → 0） */
  srcRow: number
  unit: (number | null)[]
  min: number | null
  totals: (number | null)[]
  optimal: number | null
  best: string
  status: string
  quoted: string
  note: string
}

export interface NegoSheetSpec {
  masterSheet: string
  pn: number
  qty: number
  rev: number
  description: number
  vendors: NegoSheetVendor[]
  /** 名称 MPN / MQTY / MROW 覆盖到的汇总末行（1 基 Excel 行号） */
  maxRow: number
  rows: NegoSheetRow[]
  /** 预填行之后再留几行带公式的空行，方便直接输入 */
  spareRows: number
}

/** 表头行（1 基） */
export const NEGO_HEADER_ROW = 4
/** 首个明细行（1 基） */
export const NEGO_FIRST_ROW = 5

const normPn = (v: MasterCell | string): string => String(v ?? '').trim().toUpperCase()
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6

function cellNum(v: MasterCell | undefined): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  return cleanAmountString(v)
}

const cellStr = (v: MasterCell | undefined): string => (v === null || v === undefined ? '' : String(v).trim())

/** 数字按 Excel 默认显示（20 → "20"，0.5 → "0.5"） */
const fmtNum = (n: number): string => String(round6(n))

/** 汇总表里出现过报价的供应商列（一个价都没有的列不进活表）；全空时保留全部槽位 */
export function negoSheetVendors(master: MasterData): NegoSheetVendor[] {
  const slots = master.layout.vendorSlots
  const withQuotes = slots.filter((s) =>
    master.rows.some((r) => isDataRow(r) && cellStr(r.cells[s.col]) !== ''),
  )
  return (withQuotes.length > 0 ? withQuotes : slots).map((s) => ({ col: s.col, label: s.label }))
}

/** 与 Excel 公式同一套取档/取价/状态逻辑，算出一行的缓存值 */
export function resolveNegoSheetRow(master: MasterData, input: NegoInput, vendors: NegoSheetVendor[]): NegoSheetRow {
  const L = master.layout
  const pn = input.pn.trim()
  const qty = input.qty
  const V = vendors.length
  const empty: NegoSheetRow = {
    pn,
    qty,
    rev: '',
    description: '',
    tier: null,
    srcRow: 0,
    unit: vendors.map(() => null),
    min: null,
    totals: vendors.map(() => null),
    optimal: null,
    best: '',
    status: '',
    quoted: '',
    note: '',
  }
  if (pn === '') return empty
  const tiers = pnTiers(master, pn)
  const found = tiers.length > 0
  const numeric = tiers.filter((t): t is typeof t & { qty: number } => t.qty !== null && t.qty > 0)
  const quoted = numeric.length > 0 ? numeric.map((t) => fmtNum(t.qty)).join(' / ') : '-'
  let tier: number | null = null
  let srcRow = 0
  if (qty !== null && numeric.length > 0) {
    const below = numeric.filter((t) => t.qty <= qty)
    const used = below.length > 0 ? below[below.length - 1]! : numeric[0]!
    tier = used.qty
    srcRow = used.excelRow
  }
  const cells = srcRow > 0 ? (master.rows[srcRow - 2]?.cells ?? []) : []
  const unit = vendors.map((v) => (srcRow > 0 ? cellNum(cells[v.col]) : null))
  const present = unit.filter((u): u is number => u !== null)
  const min = present.length > 0 ? Math.min(...present) : null
  const totals = unit.map((u) => (u !== null && qty !== null ? round6(u * qty) : null))
  const optimal = min !== null && qty !== null ? round6(min * qty) : null
  let best = ''
  if (min !== null) {
    const hits = unit.filter((u) => u === min).length
    best = hits > 1 ? 'TIE' : (vendors[unit.indexOf(min)]?.label ?? '')
  }
  const noteParts: string[] = []
  if (srcRow > 0) {
    vendors.forEach((v, i) => {
      const raw = cellStr(cells[v.col])
      if (unit[i] === null && raw !== '') noteParts.push(`${v.label}: ${raw}`)
    })
  }
  const note = noteParts.join(' ')
  let status: string
  if (qty === null) status = 'Qty missing'
  else if (!found) status = 'P/N not found'
  else if (srcRow === 0) status = 'No qty tier'
  else if (present.length === 0) status = note === '' ? 'Not quoted' : 'No price (see Note)'
  else if (present.length < V) status = `${present.length}/${V} quoted`
  else status = 'OK'
  return {
    pn,
    qty,
    rev: srcRow > 0 && L.rev >= 0 ? cellStr(cells[L.rev]) : '',
    description: srcRow > 0 && L.description >= 0 ? cellStr(cells[L.description]) : '',
    tier,
    srcRow,
    unit,
    min,
    totals,
    optimal,
    best,
    status,
    quoted,
    note,
  }
}

/** 比价页输入 → 活表规格：去重（同零件号留先出现的）、去空行、算缓存值 */
export function buildNegoSheetSpec(master: MasterData, inputs: NegoInput[], opts: { spareRows?: number } = {}): NegoSheetSpec {
  const L = master.layout
  const vendors = negoSheetVendors(master)
  const seen = new Set<string>()
  const rows: NegoSheetRow[] = []
  for (const it of inputs) {
    const key = normPn(it.pn)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    rows.push(resolveNegoSheetRow(master, it, vendors))
  }
  return {
    masterSheet: master.sheetName,
    pn: L.pn,
    qty: L.qty,
    rev: L.rev,
    description: L.description,
    vendors,
    // 名称覆盖范围：当前行数 + 余量，按千取整（每次导出都会重写，总表长了自动扩）
    maxRow: Math.max(5000, Math.ceil((master.rows.length + 1 + 3000) / 1000) * 1000),
    rows,
    spareRows: opts.spareRows ?? 10,
  }
}

/* ---------------- 列布局 ---------------- */

export interface NegoSheetColumns {
  names: string[]
  pn: number
  rev: number
  description: number
  qty: number
  unitStart: number
  min: number
  totalStart: number
  optimal: number
  best: number
  status: number
  tier: number
  quoted: number
  note: number
  srcRow: number
  count: number
}

export function negoSheetColumns(vendors: NegoSheetVendor[]): NegoSheetColumns {
  const V = vendors.length
  // 列序与用户的 NEGO v2 一致：单价 → Status → Min → 各家 Total → Best → Optimal → 辅助列
  const names = [
    'P/N',
    'Rev',
    'Description',
    "Q'ty",
    ...vendors.map((v) => `${v.label} Unit`),
    'Status',
    'Min',
    ...vendors.map((v) => `${v.label} Total`),
    'Best',
    'Optimal',
    'Qty Tier',
    "Quoted Q'ty",
    'Note',
    'Src Row',
  ]
  return {
    names,
    pn: 0,
    rev: 1,
    description: 2,
    qty: 3,
    unitStart: 4,
    status: 4 + V,
    min: 5 + V,
    totalStart: 6 + V,
    best: 6 + 2 * V,
    optimal: 7 + 2 * V,
    tier: 8 + 2 * V,
    quoted: 9 + 2 * V,
    note: 10 + 2 * V,
    srcRow: 11 + 2 * V,
    count: 12 + 2 * V,
  }
}

/* ---------------- 公式 ---------------- */

/** 结构化引用里的列名：[ ] # ' 用 ' 转义 */
const colSpec = (name: string): string => name.replace(/(['[\]#])/g, "'$1")
/** 工作表名：一律加引号（' 翻倍） */
export const sheetRef = (name: string): string => `'${name.replace(/'/g, "''")}'`
/** 公式字符串字面量 */
const lit = (s: string): string => `"${s.replace(/"/g, '""')}"`

export interface NegoFormula {
  formula: string
  /** 需按 CSE 数组公式求值（含对整列数组的运算） */
  array: boolean
}

/**
 * 各列公式（表格计算列与单元格共用同一文本；无公式的列为 null）。
 * 引用工作簿名称 MPN（规范化零件号数组）/ MQTY（数量数组）/ MROW（行号数组），由 negoDefinedNames 定义。
 */
export function negoFormulas(spec: NegoSheetSpec, tableName: string): (NegoFormula | null)[] {
  const C = negoSheetColumns(spec.vendors)
  const S = sheetRef(spec.masterSheet)
  const T = tableName
  const V = spec.vendors.length
  const row = (name: string): string => `${T}[[#This Row],[${colSpec(name)}]]`
  const P = `TRIM(${row('P/N')})`
  const Q = row("Q'ty")
  const R = row('Src Row')
  const TIER = row('Qty Tier')
  const MINR = row('Min')
  const unitName = (i: number): string => C.names[C.unitStart + i]!
  const UNITS =
    V === 1 ? row(unitName(0)) : `${T}[[#This Row],[${colSpec(unitName(0))}]:[${colSpec(unitName(V - 1))}]]`
  const colRef = (c: number): string => `${S}!$${colLetter(c)}:$${colLetter(c)}`
  const idx = (c: number): string => `INDEX(${colRef(c)},${R})`
  const textCol = (c: number): string => (c >= 0 ? `IF(${R}=0,"",IF(${idx(c)}="","",${idx(c)}))` : '""')
  const qn = `IFERROR(${Q}*1,0)`
  const maxLe = `MAX((MPN=${P})*(MQTY<=${qn})*MQTY)`
  const minAll = `MIN(IF((MPN=${P})*(MQTY>0),MQTY))`
  const out: (NegoFormula | null)[] = new Array(C.count).fill(null)
  out[C.rev] = { formula: textCol(spec.rev), array: false }
  out[C.description] = { formula: textCol(spec.description), array: false }
  spec.vendors.forEach((v, i) => {
    const cell = idx(v.col)
    const clean = `IFERROR(VALUE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(${cell},"￥",""),"¥",""),",","")),"")`
    out[C.unitStart + i] = { formula: `IF(${R}=0,"",IF(ISNUMBER(${cell}),${cell},${clean}))`, array: false }
    const U = row(unitName(i))
    out[C.totalStart + i] = { formula: `IF(OR(${U}="",${Q}=""),"",${Q}*${U})`, array: false }
  })
  out[C.min] = { formula: `IF(COUNT(${UNITS})=0,"",MIN(${UNITS}))`, array: false }
  out[C.optimal] = { formula: `IF(OR(${MINR}="",${Q}=""),"",${Q}*${MINR})`, array: false }
  const labels = `{${spec.vendors.map((v) => lit(v.label)).join(',')}}`
  out[C.best] = {
    formula: `IF(${MINR}="","",IF(COUNTIF(${UNITS},${MINR})>1,"TIE",INDEX(${labels},MATCH(${MINR},${UNITS},0))))`,
    array: false,
  }
  out[C.status] = {
    formula:
      `IF(${P}="","",IF(${Q}="","Qty missing",IF(SUMPRODUCT(--(MPN=${P}))=0,"P/N not found",` +
      `IF(${R}=0,"No qty tier",IF(COUNT(${UNITS})=0,IF(${row('Note')}="","Not quoted","No price (see Note)"),` +
      `IF(COUNT(${UNITS})<${V},COUNT(${UNITS})&"/${V} quoted","OK"))))))`,
    array: true,
  }
  out[C.tier] = {
    formula: `IF(OR(${P}="",${Q}=""),"",IF(${maxLe}>0,${maxLe},IF(${minAll}>0,${minAll},"")))`,
    array: true,
  }
  out[C.quoted] = {
    formula: `IF(${P}="","",IFERROR(_xlfn.TEXTJOIN(" / ",TRUE,_xlfn._xlws.SORT(_xlfn.UNIQUE(_xlfn._xlws.FILTER(MQTY,(MPN=${P})*(MQTY>0))))),"-"))`,
    array: true,
  }
  const noteParts = spec.vendors
    .map((v, i) => `IF(AND(${row(unitName(i))}="",${idx(v.col)}<>""),${lit(`${v.label}: `)}&${idx(v.col)}&" ","")`)
    .join('&')
  out[C.note] = { formula: `IF(${R}=0,"",TRIM(${noteParts}))`, array: true }
  out[C.srcRow] = { formula: `IF(${TIER}="",0,MAX((MPN=${P})*(MQTY=${TIER})*MROW))`, array: true }
  return out
}

/** 表格上方合计区用到的列公式（列整体引用） */
export function negoTopFormulas(spec: NegoSheetSpec, tableName: string): { total: string[]; allQuoted: string[]; optimal: string; optimalAllQuoted: string } {
  const C = negoSheetColumns(spec.vendors)
  const col = (name: string): string => `${tableName}[${colSpec(name)}]`
  return {
    total: spec.vendors.map((_, i) => `SUM(${col(C.names[C.totalStart + i]!)})`),
    allQuoted: spec.vendors.map((_, i) => `SUMIFS(${col(C.names[C.totalStart + i]!)},${col('Status')},"OK")`),
    optimal: `SUM(${col('Optimal')})`,
    optimalAllQuoted: `SUMIFS(${col('Optimal')},${col('Status')},"OK")`,
  }
}

/** 工作簿级名称：规范化零件号 / 数量 / 行号数组（覆盖汇总表第 2 行到 maxRow） */
export function negoDefinedNames(spec: NegoSheetSpec): { name: string; formula: string }[] {
  const S = sheetRef(spec.masterSheet)
  const rng = (c: number): string => `${S}!$${colLetter(c)}$2:$${colLetter(c)}$${spec.maxRow}`
  return [
    { name: 'MPN', formula: `TRIM(SUBSTITUTE(SUBSTITUTE(${rng(spec.pn)},CHAR(10)," "),CHAR(13)," "))` },
    { name: 'MQTY', formula: `IFERROR(VALUE(${rng(spec.qty)}),0)` },
    { name: 'MROW', formula: `ROW(${rng(spec.pn)})` },
  ]
}

/* ---------------- 样式（与用户的 NEGO v2 一致） ---------------- */

/** 浅绿 = Office 主题 accent6 (70AD47) 的 80% 淡色；表头上边框 = accent1 (4472C4) 的 40% 淡色。用 RGB 写死，不依赖目标工作簿主题 */
const GREEN = 'FFE2EFDA'
const HEADER_LINE = 'FF8EAADB'
const FONT_BODY = '<font><sz val="11"/><name val="等线"/><charset val="134"/></font>'
const FONT_TITLE = '<font><b/><sz val="16"/><name val="等线"/><charset val="134"/></font>'
const FONT_GROUP = '<font><b/><sz val="20"/><name val="等线"/><charset val="134"/></font>'
const FONT_SMALL_GRAY = '<font><sz val="9"/><color rgb="FF808080"/><name val="等线"/><charset val="134"/></font>'
const FONT_SMALL_GRAY_BOLD = '<font><b/><sz val="9"/><color rgb="FF808080"/><name val="等线"/><charset val="134"/></font>'
const FONT_HEADER = '<font><b/><sz val="10"/><name val="Aptos"/><family val="2"/></font>'
const FONT_PN = '<font><sz val="12"/><name val="Arial"/><family val="2"/></font>'
const FONT_GRAY = '<font><sz val="11"/><color rgb="FF808080"/><name val="等线"/><charset val="134"/></font>'
const FONT_DARKRED = '<font><sz val="11"/><color rgb="FF800000"/><name val="等线"/><charset val="134"/></font>'
const FONT_LIGHTGRAY = '<font><sz val="11"/><color rgb="FFC0C0C0"/><name val="等线"/><charset val="134"/></font>'
const FILL_GREEN = `<fill><patternFill patternType="solid"><fgColor rgb="${GREEN}"/><bgColor indexed="64"/></patternFill></fill>`
const FILL_WHITE = '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill>'
const thin = (side: string, color = '<color auto="1"/>'): string => `<${side} style="thin">${color}</${side}>`
const lineColor = `<color rgb="${HEADER_LINE}"/>`
const BORDER_ALL = `<border>${thin('left')}${thin('right')}${thin('top')}${thin('bottom')}<diagonal/></border>`
const BORDER_HDR_FIRST = `<border>${thin('left')}${thin('right')}${thin('top', lineColor)}${thin('bottom')}<diagonal/></border>`
const BORDER_HDR_LEFT = `<border>${thin('left')}<right/>${thin('top', lineColor)}${thin('bottom')}<diagonal/></border>`
const BORDER_HDR_MID = `<border><left/><right/>${thin('top', lineColor)}${thin('bottom', lineColor)}<diagonal/></border>`
const BORDER_HDR_RIGHT = `<border><left/>${thin('right')}${thin('top', lineColor)}${thin('bottom')}<diagonal/></border>`
/** ¥ 金额格式（参考文件 numFmt 189 / 188） */
export const NEGO_MONEY_FORMAT = '[$¥-804]#,##0.00'
export const NEGO_SUM_FORMAT = '[$¥-804]#,##0.00;[Red][$¥-804]#,##0.00'

/** 单元格样式定义（写进目标工作簿 styles.xml，按内容去重） */
export interface NegoCellStyleDef {
  font: string
  fill?: string
  border?: string
  /** 内置格式号，或自定义 formatCode */
  numFmt?: number | string
  /** <alignment …/> 的属性串 */
  align?: string
}

export const NEGO_CELL_STYLES = {
  /** B1 标题 */
  title: { font: FONT_TITLE, fill: FILL_GREEN },
  /** 标题区其余浅绿空格 */
  green: { font: FONT_BODY, fill: FILL_GREEN },
  /** 第 1 行各家标签（HC / SKW / Optimal） */
  groupLabel: { font: FONT_GROUP, fill: FILL_GREEN, align: 'horizontal="center" vertical="center"' },
  /** 第 2 行各家合计 */
  sum: { font: FONT_TITLE, fill: FILL_GREEN, numFmt: NEGO_SUM_FORMAT },
  /** A3 说明文字 */
  plain: { font: FONT_BODY },
  /** 第 3 行 "All quoted" 标签 */
  allQuotedLabel: { font: FONT_SMALL_GRAY, fill: FILL_GREEN, align: 'horizontal="right"' },
  /** 第 3 行全部有价合计 */
  allQuotedSum: { font: FONT_SMALL_GRAY_BOLD, fill: FILL_GREEN, numFmt: 3 },
  /** 表头 A4（白底四边框） */
  headerFirst: { font: FONT_HEADER, fill: FILL_WHITE, border: BORDER_HDR_FIRST, align: 'horizontal="center" vertical="center"' },
  headerLeft: { font: FONT_HEADER, fill: FILL_GREEN, border: BORDER_HDR_LEFT, align: 'horizontal="center" vertical="center"' },
  headerMid: { font: FONT_HEADER, fill: FILL_GREEN, border: BORDER_HDR_MID, align: 'horizontal="center" vertical="center" wrapText="1"' },
  headerRight: { font: FONT_HEADER, fill: FILL_GREEN, border: BORDER_HDR_RIGHT, align: 'horizontal="center" vertical="center"' },
  /** 表头其余列 */
  header: { font: FONT_HEADER, fill: FILL_GREEN },
  /** 零件号：Arial 12 居中、四边框、文本格式 */
  pn: { font: FONT_PN, border: BORDER_ALL, numFmt: 49, align: 'horizontal="center" vertical="center" wrapText="1"' },
  /** 金额列（单价 / Min / Total / Optimal / Best） */
  money: { font: FONT_BODY, numFmt: NEGO_MONEY_FORMAT },
  status: { font: FONT_BODY, numFmt: NEGO_MONEY_FORMAT, align: 'horizontal="left"' },
  quoted: { font: FONT_GRAY },
  note: { font: FONT_DARKRED },
  /** Src Row 辅助列：浅灰居中 */
  aux: { font: FONT_LIGHTGRAY, align: 'horizontal="center"' },
  /** Qty Tier：灰色居中 */
  tier: { font: FONT_GRAY, align: 'horizontal="center"' },
} satisfies Record<string, NegoCellStyleDef>

export type NegoCellStyleRole = keyof typeof NEGO_CELL_STYLES

/** 表格列 dataDxf（Excel 给新加的行套用）与条件格式 dxf */
export const NEGO_DXF_DEFS = {
  pn: `<dxf><font><sz val="12"/><name val="Arial"/><family val="2"/><scheme val="none"/></font><alignment horizontal="center" vertical="center" wrapText="1"/><border>${thin('left')}${thin('right')}${thin('top')}${thin('bottom')}</border></dxf>`,
  money: (numFmtId: number): string => `<dxf><numFmt numFmtId="${numFmtId}" formatCode="${NEGO_MONEY_FORMAT}"/></dxf>`,
  status: (numFmtId: number): string => `<dxf><numFmt numFmtId="${numFmtId}" formatCode="${NEGO_MONEY_FORMAT}"/><alignment horizontal="left"/></dxf>`,
  quoted: '<dxf><font><color rgb="FF808080"/></font></dxf>',
  note: '<dxf><font><color rgb="FF800000"/></font></dxf>',
  aux: '<dxf><font><color rgb="FFC0C0C0"/></font><alignment horizontal="center"/></dxf>',
  tier: '<dxf><font><color rgb="FF808080"/></font><alignment horizontal="center"/></dxf>',
  /** 条件格式：红色加粗（Status 非 OK / 数量不在档上时的 Quoted Q'ty） */
  alert: '<dxf><font><b/><i val="0"/><color rgb="FFFF0000"/></font></dxf>',
}

export type NegoDxfRole = keyof typeof NEGO_DXF_DEFS

/** 目标工作簿里解析好的样式下标 */
export interface NegoStyleIds {
  cell: Record<NegoCellStyleRole, number>
  dxf: Record<NegoDxfRole, number>
}

/** 无样式（降级 / 单测）：全部 0 */
export const NEGO_NO_STYLES: NegoStyleIds = {
  cell: Object.fromEntries(Object.keys(NEGO_CELL_STYLES).map((k) => [k, 0])) as Record<NegoCellStyleRole, number>,
  dxf: Object.fromEntries(Object.keys(NEGO_DXF_DEFS).map((k) => [k, 0])) as Record<NegoDxfRole, number>,
}

/** 每列的单元格样式与表格 dataDxf 角色 */
export function negoColumnRoles(C: NegoSheetColumns): { cell: NegoCellStyleRole; dxf: NegoDxfRole | null }[] {
  return C.names.map((_, i) => {
    if (i === C.pn) return { cell: 'pn', dxf: 'pn' }
    if (i === C.status) return { cell: 'status', dxf: 'status' }
    if ((i >= C.unitStart && i < C.status) || i === C.min || (i >= C.totalStart && i < C.best) || i === C.best || i === C.optimal)
      return { cell: 'money', dxf: 'money' }
    if (i === C.tier) return { cell: 'tier', dxf: 'tier' }
    if (i === C.quoted) return { cell: 'quoted', dxf: 'quoted' }
    if (i === C.note) return { cell: 'note', dxf: 'note' }
    if (i === C.srcRow) return { cell: 'aux', dxf: 'aux' }
    return { cell: 'plain', dxf: null }
  })
}

/* ---------------- XML 片段 ---------------- */

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const sAttr = (s: number): string => (s > 0 ? ` s="${s}"` : '')
const strCell = (ref: string, s: string, style = 0): string =>
  `<c r="${ref}"${sAttr(style)} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(s)}</t></is></c>`
const numCell = (ref: string, n: number, style = 0): string => `<c r="${ref}"${sAttr(style)}><v>${n}</v></c>`
const emptyCell = (ref: string, style: number): string => (style > 0 ? `<c r="${ref}" s="${style}"/>` : '')

/** 公式单元格：缓存值为数字 / 非空字符串；"" 或无缓存值 → 只写公式（读回为空格，Excel 打开时全量重算） */
function formulaCell(ref: string, f: NegoFormula, cached: number | string | null, style = 0): string {
  const fx = f.array ? `<f t="array" ref="${ref}">${xmlEscape(f.formula)}</f>` : `<f>${xmlEscape(f.formula)}</f>`
  if (typeof cached === 'number') return `<c r="${ref}"${sAttr(style)}>${fx}<v>${cached}</v></c>`
  if (typeof cached === 'string' && cached !== '') return `<c r="${ref}"${sAttr(style)} t="str">${fx}<v>${xmlEscape(cached)}</v></c>`
  return `<c r="${ref}"${sAttr(style)}>${fx}</c>`
}

/** 表格 ref 的末行（1 基） */
export const negoTableBottom = (spec: NegoSheetSpec): number => NEGO_HEADER_ROW + Math.max(1, spec.rows.length + spec.spareRows)

/** 表格部件 XML（计算列公式让用户新加的行自动带公式；dataDxf 让新行沿用列样式） */
export function negoTableXml(spec: NegoSheetSpec, table: { id: number; name: string }, st: NegoStyleIds = NEGO_NO_STYLES): string {
  const C = negoSheetColumns(spec.vendors)
  const fx = negoFormulas(spec, table.name)
  const roles = negoColumnRoles(C)
  const ref = `A${NEGO_HEADER_ROW}:${colLetter(C.count - 1)}${negoTableBottom(spec)}`
  const cols = C.names
    .map((name, i) => {
      const f = fx[i]
      const dxfRole = roles[i]!.dxf
      const dxf = dxfRole && st !== NEGO_NO_STYLES ? ` dataDxfId="${st.dxf[dxfRole]}"` : ''
      const open = `<tableColumn id="${i + 1}" name="${xmlEscape(name)}"${dxf}`
      if (!f) return `${open}/>`
      return `${open}><calculatedColumnFormula${f.array ? ' array="1"' : ''}>${xmlEscape(f.formula)}</calculatedColumnFormula></tableColumn>`
    })
    .join('')
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${table.id}" name="${xmlEscape(table.name)}" displayName="${xmlEscape(table.name)}" ref="${ref}" totalsRowShown="0">` +
    `<autoFilter ref="${ref}"/><tableColumns count="${C.count}">${cols}</tableColumns>` +
    `<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`
  )
}

/** 列宽（参考 NEGO v2） */
export function negoColsXml(spec: NegoSheetSpec): string {
  const C = negoSheetColumns(spec.vendors)
  const widths: number[] = C.names.map((_, i) => {
    if (i === C.pn) return 22
    if (i === C.description) return 41.64
    if (i === C.rev || i === C.qty) return 9
    if (i >= C.unitStart && i < C.status) return 13.79
    if (i === C.status) return 20.64
    if (i === C.min) return 11.21
    if (i >= C.totalStart && i < C.best) return 16.5
    if (i === C.best) return 7.64
    if (i === C.optimal) return 18.64
    if (i === C.quoted || i === C.note) return 26.64
    return 8.64 // Qty Tier / Src Row
  })
  return `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
}

/** sheetData：标题区（1–3 行）+ 表头（第 4 行）+ 预填行 + 带公式的空行 */
export function negoSheetDataXml(spec: NegoSheetSpec, tableName: string, st: NegoStyleIds = NEGO_NO_STYLES): string {
  const C = negoSheetColumns(spec.vendors)
  const fx = negoFormulas(spec, tableName)
  const top = negoTopFormulas(spec, tableName)
  const roles = negoColumnRoles(C)
  const cs = st.cell
  const ref = (c: number, r: number): string => `${colLetter(c)}${r}`
  const sumOf = (vals: (number | null)[]): number => round6(vals.reduce<number>((s, v) => s + (v ?? 0), 0))
  const okRows = spec.rows.filter((r) => r.status === 'OK')
  const rowXml = (r: number, cells: string[], attrs = ''): string => (cells.length ? `<row r="${r}"${attrs}>${cells.join('')}</row>` : '')
  /** 标题区：B 列到 Optimal 列都是浅绿底（参考文件的做法），没写内容的格也带样式 */
  const greenRow = (r: number, written: Map<number, string>): string[] => {
    const cells: string[] = []
    for (let c = 0; c < C.count; c++) {
      const w = written.get(c)
      if (w) cells.push(w)
      else if (c >= 1 && c <= C.optimal) {
        const e = emptyCell(ref(c, r), cs.green)
        if (e) cells.push(e)
      }
    }
    return cells
  }
  const out: string[] = []
  // 第 1 行：标题 + 各家标签
  const r1 = new Map<number, string>([[1, strCell('B1', 'Basis For Negotiation', cs.title)]])
  spec.vendors.forEach((v, i) => r1.set(C.totalStart + i, strCell(ref(C.totalStart + i, 1), v.label, cs.groupLabel)))
  r1.set(C.optimal, strCell(ref(C.optimal, 1), 'Optimal', cs.groupLabel))
  out.push(rowXml(1, greenRow(1, r1), ' ht="25.3" customHeight="1"'))
  // 第 2 行：各家合计 / 最优合计
  const r2 = new Map<number, string>()
  spec.vendors.forEach((_, i) =>
    r2.set(
      C.totalStart + i,
      formulaCell(ref(C.totalStart + i, 2), { formula: top.total[i]!, array: false }, sumOf(spec.rows.map((r) => r.totals[i] ?? null)), cs.sum),
    ),
  )
  r2.set(C.optimal, formulaCell(ref(C.optimal, 2), { formula: top.optimal, array: false }, sumOf(spec.rows.map((r) => r.optimal)), cs.sum))
  out.push(rowXml(2, greenRow(2, r2), ' ht="20.15" customHeight="1"'))
  // 第 3 行：说明 + 全部有价行的合计
  const r3 = new Map<number, string>([
    [0, strCell('A3', "Copy PN + Q'ty from PO", cs.plain)],
    [C.min, strCell(ref(C.min, 3), 'All quoted', cs.allQuotedLabel)],
  ])
  spec.vendors.forEach((_, i) =>
    r3.set(
      C.totalStart + i,
      formulaCell(ref(C.totalStart + i, 3), { formula: top.allQuoted[i]!, array: false }, sumOf(okRows.map((r) => r.totals[i] ?? null)), cs.allQuotedSum),
    ),
  )
  r3.set(C.optimal, formulaCell(ref(C.optimal, 3), { formula: top.optimalAllQuoted, array: false }, sumOf(okRows.map((r) => r.optimal)), cs.allQuotedSum))
  out.push(rowXml(3, greenRow(3, r3)))
  // 第 4 行：表头（A 白底四边框，B–D 带框线，其余浅绿）
  const headerStyle = (c: number): number =>
    c === 0 ? cs.headerFirst : c === 1 ? cs.headerLeft : c === 2 ? cs.headerMid : c === 3 ? cs.headerRight : cs.header
  out.push(rowXml(NEGO_HEADER_ROW, C.names.map((n, i) => strCell(ref(i, NEGO_HEADER_ROW), n, headerStyle(i)))))
  // 明细行
  const bottom = negoTableBottom(spec)
  for (let r = NEGO_FIRST_ROW; r <= bottom; r++) {
    const data = spec.rows[r - NEGO_FIRST_ROW] ?? null
    const cells: string[] = []
    for (let c = 0; c < C.count; c++) {
      const f = fx[c]
      const at = ref(c, r)
      const style = cs[roles[c]!.cell]
      if (!f) {
        if (c === C.pn && data && data.pn !== '') cells.push(strCell(at, data.pn, style))
        else if (c === C.qty && data && data.qty !== null) cells.push(numCell(at, data.qty, style))
        else {
          const e = emptyCell(at, style)
          if (e) cells.push(e)
        }
        continue
      }
      let cached: number | string | null
      if (!data) cached = c === C.srcRow ? 0 : ''
      else if (c === C.rev) cached = data.rev
      else if (c === C.description) cached = data.description
      else if (c >= C.unitStart && c < C.status) cached = data.unit[c - C.unitStart] ?? ''
      else if (c === C.status) cached = data.status
      else if (c === C.min) cached = data.min ?? ''
      else if (c >= C.totalStart && c < C.best) cached = data.totals[c - C.totalStart] ?? ''
      else if (c === C.best) cached = data.best
      else if (c === C.optimal) cached = data.optimal ?? ''
      else if (c === C.tier) cached = data.tier ?? ''
      else if (c === C.quoted) cached = data.quoted
      else if (c === C.note) cached = data.note
      else if (c === C.srcRow) cached = data.srcRow
      else cached = null
      cells.push(formulaCell(at, f, cached, style))
    }
    out.push(rowXml(r, cells, ' ht="15" customHeight="1"'))
  }
  return `<sheetData>${out.join('')}</sheetData>`
}

/**
 * 条件格式（与参考一致，红色加粗）：Status 非 OK；数量不在档上（Qty Tier ≠ Q'ty 或没有数量档）时 Quoted Q'ty 提醒。
 * 范围放宽到表格下方 500 行，表格扩展后仍生效
 */
export function negoConditionalFormattingXml(spec: NegoSheetSpec, st: NegoStyleIds = NEGO_NO_STYLES): string {
  const C = negoSheetColumns(spec.vendors)
  const last = negoTableBottom(spec) + 500
  const r0 = NEGO_FIRST_ROW
  const L = (c: number): string => colLetter(c)
  const rule = (sqref: string, dxfId: number, priority: number, formula: string): string =>
    `<conditionalFormatting sqref="${sqref}"><cfRule type="expression" dxfId="${dxfId}" priority="${priority}" stopIfTrue="1"><formula>${xmlEscape(formula)}</formula></cfRule></conditionalFormatting>`
  const S = `$${L(C.status)}${r0}`
  const T = `$${L(C.tier)}${r0}`
  return (
    rule(`${L(C.status)}${r0}:${L(C.status)}${last}`, st.dxf.alert, 1, `AND(${S}<>"",${S}<>"OK")`) +
    rule(`${L(C.quoted)}${r0}:${L(C.quoted)}${last}`, st.dxf.alert, 2, `OR(${S}="No qty tier",AND(${T}<>"",${T}<>$${L(C.qty)}${r0}))`)
  )
}

/**
 * 在原 NEGO sheet XML 的基础上重建：保留根元素（命名空间声明）、sheetPr（codeName 供宏引用）、
 * 视图 / 页边距 / 页面设置 / 页眉页脚 / 图形引用；列宽、行高默认值、单元格、条件格式、表格全部按活表重写。
 */
export function negoSheetXml(
  original: string,
  spec: NegoSheetSpec,
  tableName: string,
  tableRId: string,
  st: NegoStyleIds = NEGO_NO_STYLES,
): string {
  const C = negoSheetColumns(spec.vendors)
  const rootOpen = original.match(/<worksheet\b[^>]*>/)?.[0] ?? '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  const pick = (name: string): string => {
    const m = original.match(new RegExp(`<${name}\\b(?:[^>]*/>|[^>]*>[\\s\\S]*?</${name}>)`))
    return m ? m[0] : ''
  }
  const dimension = `<dimension ref="A1:${colLetter(C.count - 1)}${negoTableBottom(spec)}"/>`
  const tableParts = `<tableParts count="1"><tablePart xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${tableRId}"/></tableParts>`
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    rootOpen +
    pick('sheetPr') +
    dimension +
    pick('sheetViews') +
    '<sheetFormatPr defaultColWidth="9" defaultRowHeight="14.15"/>' +
    negoColsXml(spec) +
    negoSheetDataXml(spec, tableName, st) +
    negoConditionalFormattingXml(spec, st) +
    pick('printOptions') +
    pick('pageMargins') +
    pick('pageSetup') +
    pick('headerFooter') +
    pick('drawing') +
    pick('legacyDrawing') +
    pick('legacyDrawingHF') +
    pick('picture') +
    pick('oleObjects') +
    pick('controls') +
    tableParts +
    '</worksheet>'
  )
}
