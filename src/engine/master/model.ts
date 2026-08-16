import { normalizeHeader } from '../synonyms'
import { sheetGrid, type ParsedWorkbook } from '../workbook'
import { KK_HEADERS } from '../export/kkLayout'
import type { Grid } from '../types'

export const KK_COL_COUNT = 33
/** 汇总表最大读取行数（当前真实数据 ~800 行，留足余量） */
export const MASTER_MAX_ROWS = 20000

export type MasterCell = string | number | null

/** 汇总表一行 = 33 个原始值（A–AG），保持导入导出往返保真 */
export interface MasterRow {
  cells: MasterCell[]
}

export interface PassthroughSheet {
  name: string
  grid: MasterCell[][]
}

export interface MasterData {
  /** 从 Excel 第 2 行起的所有行（含只有 A 列序号的预编号空行区） */
  rows: MasterRow[]
  /** 汇总 sheet 名（导出时沿用） */
  sheetName: string
  /** 其他 sheet（如 NEGO）按值透传，导出时写回 */
  passthrough: PassthroughSheet[]
  sourceFileName: string | null
  importedAt: number | null
}

const NORMALIZED_KK_HEADERS = KK_HEADERS.map((h) => normalizeHeader(h))

/** 该 sheet 的第一行与 KK 汇总模板表头的匹配列数 */
export function kkHeaderMatchCount(grid: Grid): number {
  const header = grid[0] ?? []
  let match = 0
  for (let c = 0; c < KK_COL_COUNT; c++) {
    const cell = header[c]
    if (!cell || cell.v === null) continue
    if (normalizeHeader(String(cell.v)) === NORMALIZED_KK_HEADERS[c]) match++
  }
  return match
}

/** 找出工作簿里的 KK 汇总 sheet（名字含"汇总"或表头匹配 ≥ 20 列） */
export function findMasterSheet(pw: ParsedWorkbook): string | null {
  let best: { name: string; score: number } | null = null
  for (const name of pw.sheetNames) {
    const grid = sheetGrid(pw, name, 2)
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
  const grid = sheetGrid(pw, sheetName, MASTER_MAX_ROWS, KK_COL_COUNT + 7)
  const all = gridToCells(grid, KK_COL_COUNT)
  // 第 1 行是表头；数据行从第 2 行（下标 1）开始
  const body = all.slice(1).map((cells) => {
    const padded = cells.slice(0, KK_COL_COUNT)
    while (padded.length < KK_COL_COUNT) padded.push(null)
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
  return { rows, sheetName, passthrough, sourceFileName: fileName, importedAt: Date.now() }
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
