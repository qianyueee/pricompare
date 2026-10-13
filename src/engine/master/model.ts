import { normalizeHeader } from '../synonyms'
import { sheetGrid, type ParsedWorkbook } from '../workbook'
import { KK_HEADERS, KK_LEGACY_HEADERS } from '../export/kkLayout'
import type { Grid } from '../types'

export const KK_COL_COUNT = 34
/** 汇总表最大读取行数（当前真实数据 ~800 行，留足余量） */
export const MASTER_MAX_ROWS = 20000

export type MasterCell = string | number | null

/** 汇总表一行 = 34 个原始值（A–AH，按 KK_HEADERS 的列序），保持导入导出往返保真 */
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
/** 表头最多往右找这么多列（用户可能在表尾加了自己的列） */
const HEADER_SCAN_COLS = KK_COL_COUNT + 16

/**
 * 按表头文字对位：返回 KK_HEADERS 每一列在源表里的物理列号（找不到为 null）。
 * 用户挪过列（10-07 把 YJ 从 M 挪到 AG、新增 CL）也能读对，不依赖固定列号。
 */
export function kkColumnMap(header: readonly (string | null | undefined)[]): (number | null)[] {
  const pos = new Map<string, number>()
  header.slice(0, HEADER_SCAN_COLS).forEach((h, i) => {
    if (h === null || h === undefined) return
    const key = normalizeHeader(String(h))
    if (key && !pos.has(key)) pos.set(key, i)
  })
  return NORMALIZED_KK_HEADERS.map((key) => pos.get(key) ?? null)
}

function headerTexts(grid: Grid): (string | null)[] {
  return (grid[0] ?? []).map((cell) => (cell && cell.v !== null ? String(cell.v) : null))
}

/** 该 sheet 的第一行与 KK 汇总模板表头的匹配列数（按表头文字，不看位置） */
export function kkHeaderMatchCount(grid: Grid): number {
  return kkColumnMap(headerTexts(grid)).filter((p) => p !== null).length
}

/** 找出工作簿里的 KK 汇总 sheet（名字含"汇总"或表头匹配 ≥ 20 列） */
export function findMasterSheet(pw: ParsedWorkbook): string | null {
  let best: { name: string; score: number } | null = null
  for (const name of pw.sheetNames) {
    const grid = sheetGrid(pw, name, 2, HEADER_SCAN_COLS)
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

export interface ParsedMaster {
  master: MasterData
  /** KK_HEADERS 每一列在源 sheet 里的物理列号（null = 源表没有这一列） */
  columnMap: (number | null)[]
}

/** 解析 KK 汇总工作簿，同时给出逻辑列 → 物理列的对位；不是汇总表返回 null */
export function parseMasterWorkbookDetailed(pw: ParsedWorkbook, fileName: string): ParsedMaster | null {
  const sheetName = findMasterSheet(pw)
  if (!sheetName) return null
  const grid = sheetGrid(pw, sheetName, MASTER_MAX_ROWS, HEADER_SCAN_COLS)
  const columnMap = kkColumnMap(headerTexts(grid))
  const all = gridToCells(grid, HEADER_SCAN_COLS)
  // 第 1 行是表头；数据行从第 2 行（下标 1）开始
  const body = all.slice(1).map((src) => ({
    cells: columnMap.map((p) => (p === null ? null : (src[p] ?? null))),
  }))
  // 去掉尾部完全空的行（保留只有 A 列序号的预编号行）
  let end = body.length
  while (end > 0 && body[end - 1]!.cells.every((c) => c === null || String(c).trim() === '')) end--
  const rows = body.slice(0, end)

  const passthrough: PassthroughSheet[] = []
  for (const name of pw.sheetNames) {
    if (name === sheetName) continue
    passthrough.push({ name, grid: gridToCells(sheetGrid(pw, name, 5000, 64), 64) })
  }
  return {
    master: { rows, sheetName, passthrough, sourceFileName: fileName, importedAt: Date.now() },
    columnMap,
  }
}

/** 解析 KK 汇总工作簿为 MasterData；不是汇总表返回 null */
export function parseMasterWorkbook(pw: ParsedWorkbook, fileName: string): MasterData | null {
  return parseMasterWorkbookDetailed(pw, fileName)?.master ?? null
}

/** 旧布局（33 列）每一列在新布局里的列号 */
const LEGACY_TO_CURRENT: readonly number[] = KK_LEGACY_HEADERS.map((h, i) => {
  // 同名表头按出现顺序对位（布局里没有重名表头）
  const idx = KK_HEADERS.indexOf(h)
  return idx >= 0 ? idx : i
})

/**
 * 旧版本存下的总表（每行 33 格，10-07 之前的布局）迁移到当前 34 列布局：
 * BY 从 L 到 M、YJ 从 M 到 AG、Base ID 从 AG 到 AH，L 列 CL 留空。已是新布局的行原样保留。
 */
export function migrateMasterLayout(master: MasterData): { master: MasterData; migratedRows: number } {
  let migratedRows = 0
  const rows = master.rows.map((row) => {
    if (row.cells.length !== KK_LEGACY_HEADERS.length) return row
    migratedRows++
    const cells: MasterCell[] = Array.from({ length: KK_COL_COUNT }, () => null)
    row.cells.forEach((v, i) => {
      cells[LEGACY_TO_CURRENT[i]!] = v
    })
    return { cells }
  })
  return migratedRows === 0 ? { master, migratedRows } : { master: { ...master, rows }, migratedRows }
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
