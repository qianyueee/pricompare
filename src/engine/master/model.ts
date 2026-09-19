import { normalizeHeader } from '../synonyms'
import { sheetGrid, type ParsedWorkbook } from '../workbook'
import { KK_HEADERS } from '../export/kkLayout'
import type { Grid } from '../types'

/** KK 模板的逻辑列数（A–AG）；实际文件可能多出插入的供应商列等，以 layout.colCount 为准 */
export const KK_COL_COUNT = 33
/** 汇总表最大读取行数（当前真实数据 ~800 行，留足余量） */
export const MASTER_MAX_ROWS = 20000
/** 汇总表最大读取列数（模板 33 列 + 用户插入的列留余量） */
export const MASTER_MAX_COLS = 64

export type MasterCell = string | number | null

/** 汇总表一行 = 按文件物理列序存的原始值（长度 = layout.colCount），保持导入导出往返保真 */
export interface MasterRow {
  cells: MasterCell[]
}

export interface PassthroughSheet {
  name: string
  grid: MasterCell[][]
}

export interface VendorSlot {
  /** 物理列（0 基） */
  col: number
  /** 表头文字（Mao / HC / SKW / CL …） */
  label: string
}

/**
 * 汇总表的列布局：按表头文字定位各逻辑列的**物理列号**（0 基）。
 * 用户在模板里插列（如 SKW 后加新供应商 CL）后，右侧所有列整体右移——引擎一律通过 layout 取列，
 * 不再假设固定 33 列。模板里没有的逻辑列为 -1（读到 undefined 视同空，写入时跳过）。
 */
export interface MasterLayout {
  colCount: number
  /** 物理表头文字（缺失位补模板名） */
  headers: string[]
  no: number
  name: number
  item: number
  pn: number
  rev: number
  description: number
  qty: number
  quoteEach: number
  /** 供应商价格列：Quote(each) 与 US Vendor 之间的全部列（含用户插入的新供应商） */
  vendorSlots: VendorSlot[]
  usVendor: number
  usd: number
  /** Q..T 成本分项（Cleaning / Material Cost / Shipping+Tariff / Cost），参与金额清洗 */
  costCols: number[]
  quoteEa: number
  quoteNo: number
  leadTime: number
  material: number
  surfaceFinish: number
  cleaningSpec: number
  process: number
  size: number
  partType: number
  comment: number
  comment2: number
  basePn: number
  baseId: number
}

export interface MasterData {
  /** 从 Excel 第 2 行起的所有行（含只有 A 列序号的预编号空行区） */
  rows: MasterRow[]
  /** 汇总 sheet 名（导出时沿用） */
  sheetName: string
  /** 列布局（按表头定位） */
  layout: MasterLayout
  /** 其他 sheet（如 NEGO）按值透传，导出时写回 */
  passthrough: PassthroughSheet[]
  sourceFileName: string | null
  importedAt: number | null
}

const NORMALIZED_KK_HEADERS = KK_HEADERS.map((h) => normalizeHeader(h))

/** KK_HEADERS 下标 → layout 字段名（供应商 I–N 与成本 Q–T 另行按区间处理） */
const LOGICAL_FIELDS: Record<number, keyof MasterLayout> = {
  0: 'no',
  1: 'name',
  2: 'item',
  3: 'pn',
  4: 'rev',
  5: 'description',
  6: 'qty',
  7: 'quoteEach',
  14: 'usVendor',
  15: 'usd',
  20: 'quoteEa',
  21: 'quoteNo',
  22: 'leadTime',
  23: 'material',
  24: 'surfaceFinish',
  25: 'cleaningSpec',
  26: 'process',
  27: 'size',
  28: 'partType',
  29: 'comment',
  30: 'comment2',
  31: 'basePn',
  32: 'baseId',
}

export interface LayoutDetection {
  layout: MasterLayout
  /** 表头行里认出的 KK 模板列数（0–33） */
  score: number
}

/**
 * 按表头文字识别列布局。逐个模板表头在物理表头里找第一个（尚未占用的）归一化全等的列；
 * 供应商列 = Quote(each) 与 US Vendor 之间的全部列。P/N 与数量列缺一不可，否则返回 null。
 */
export function detectKKLayout(headerCells: readonly (string | number | null | undefined)[]): LayoutDetection | null {
  const phys = headerCells.map((v) => (v === null || v === undefined ? '' : String(v)))
  const normPhys = phys.map((h) => normalizeHeader(h))
  const claimed = new Set<number>()
  const physOf: number[] = Array.from({ length: KK_COL_COUNT }, () => -1)
  let score = 0
  for (let i = 0; i < KK_COL_COUNT; i++) {
    const target = NORMALIZED_KK_HEADERS[i]!
    for (let c = 0; c < normPhys.length; c++) {
      if (claimed.has(c) || normPhys[c] !== target) continue
      physOf[i] = c
      claimed.add(c)
      score++
      break
    }
  }
  if (physOf[3]! < 0 || physOf[6]! < 0) return null

  let lastHeader = -1
  phys.forEach((h, c) => {
    if (h.trim() !== '') lastHeader = c
  })
  const maxMapped = Math.max(...physOf)
  const colCount = Math.max(lastHeader + 1, maxMapped + 1, KK_COL_COUNT)

  // 供应商区间：Quote(each) 之后、US Vendor（或其后首个已识别列）之前
  const quoteEach = physOf[7]!
  let vendorEnd = physOf[14]!
  if (vendorEnd < 0) {
    const after = physOf.slice(15).filter((c) => c > quoteEach)
    vendorEnd = after.length > 0 ? Math.min(...after) : quoteEach + 7
  }
  const vendorSlots: VendorSlot[] = []
  if (quoteEach >= 0) {
    for (let c = quoteEach + 1; c < vendorEnd && c < colCount; c++) {
      const label = phys[c]?.trim() || `列${c + 1}`
      vendorSlots.push({ col: c, label })
    }
  }
  const costCols = [16, 17, 18, 19].map((i) => physOf[i]!).filter((c) => c >= 0)

  const headers: string[] = []
  for (let c = 0; c < colCount; c++) {
    const own = phys[c]?.trim() ?? ''
    if (own !== '') {
      headers.push(phys[c]!)
      continue
    }
    const logical = physOf.indexOf(c)
    headers.push(logical >= 0 ? KK_HEADERS[logical]! : '')
  }

  const layout = {
    colCount,
    headers,
    vendorSlots,
    costCols,
  } as MasterLayout
  for (const [idx, field] of Object.entries(LOGICAL_FIELDS)) {
    ;(layout as unknown as Record<string, unknown>)[field] = physOf[Number(idx)]!
  }
  return { layout, score }
}

/** KK 模板原样（33 列、无插列）的布局；无原文件从零新建时使用 */
export const CANONICAL_LAYOUT: MasterLayout = detectKKLayout(KK_HEADERS)!.layout

/** 该 sheet 的第一行与 KK 汇总模板表头能对上的列数（按表头文字，不要求位置一致） */
export function kkHeaderMatchCount(grid: Grid): number {
  const header = grid[0] ?? []
  const cells = header.map((cell) => (cell && cell.v !== null ? cell.v : null))
  return detectKKLayout(cells)?.score ?? 0
}

/** 找出工作簿里的 KK 汇总 sheet（名字含"汇总"或表头匹配 ≥ 20 列） */
export function findMasterSheet(pw: ParsedWorkbook): string | null {
  let best: { name: string; score: number } | null = null
  for (const name of pw.sheetNames) {
    const grid = sheetGrid(pw, name, 2, MASTER_MAX_COLS)
    let score = kkHeaderMatchCount(grid)
    if (name.includes('汇总')) score += 5
    if (!best || score > best.score) best = { name, score }
  }
  return best && best.score >= 20 ? best.name : null
}

/** 判断一个已解析的工作簿是否是 KK 汇总表（用于拖放时自动分流） */
export function isMasterWorkbook(pw: ParsedWorkbook): boolean {
  return findMasterSheet(pw) !== null
}

function gridToCells(grid: Grid, maxCols: number): MasterCell[][] {
  return grid.map((row) => {
    const out: MasterCell[] = []
    const len = Math.min(row?.length ?? 0, maxCols)
    for (let c = 0; c < len; c++) {
      const cell = row?.[c]
      if (!cell) {
        out.push(null)
      } else if (cell.isError) {
        out.push(cell.w ?? '#ERROR')
      } else {
        out.push(cell.v)
      }
    }
    return out
  })
}

/** 解析 KK 汇总工作簿为 MasterData；不是汇总表返回 null */
export function parseMasterWorkbook(pw: ParsedWorkbook, fileName: string): MasterData | null {
  const sheetName = findMasterSheet(pw)
  if (!sheetName) return null
  const grid = sheetGrid(pw, sheetName, MASTER_MAX_ROWS, MASTER_MAX_COLS)
  const headerCells = (grid[0] ?? []).map((cell) => (cell && cell.v !== null ? cell.v : null))
  const detected = detectKKLayout(headerCells)
  if (!detected) return null
  const { layout } = detected
  const all = gridToCells(grid, layout.colCount)
  // 第 1 行是表头；数据行从第 2 行（下标 1）开始
  const body = all.slice(1).map((cells) => {
    const padded = cells.slice(0, layout.colCount)
    while (padded.length < layout.colCount) padded.push(null)
    return { cells: padded }
  })
  // 去掉尾部完全空的行（保留只有 A 列序号的预编号行）
  let end = body.length
  while (end > 0 && body[end - 1]!.cells.every((c) => c === null || String(c).trim() === '')) end--
  const rows = body.slice(0, end)

  const passthrough: PassthroughSheet[] = []
  for (const name of pw.sheetNames) {
    if (name === sheetName) continue
    passthrough.push({ name, grid: gridToCells(sheetGrid(pw, name, 5000, 64), 64) })
  }
  return { rows, sheetName, layout, passthrough, sourceFileName: fileName, importedAt: Date.now() }
}

/** 行内是否只有 A 列序号（预编号空行，可被追加占用） */
export function isPlaceholderRow(row: MasterRow): boolean {
  const [a, ...rest] = row.cells
  return (
    a !== null &&
    String(a).trim() !== '' &&
    rest.every((c) => c === null || String(c).trim() === '')
  )
}

/** 行内是否有实际数据（用于统计与显示过滤） */
export function isDataRow(row: MasterRow): boolean {
  return row.cells.some((c, i) => i > 0 && c !== null && String(c).trim() !== '')
}
