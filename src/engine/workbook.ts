import * as XLSX from 'xlsx'
import type { Cell, Grid } from './types'

/** 单个 sheet 最多读取的行/列数，防止病态大表（如 3 万行的历史汇总）拖垮内存 */
export const MAX_SCAN_ROWS = 3000
export const MAX_SCAN_COLS = 64

export interface ParsedWorkbook {
  sheetNames: string[]
  wb: XLSX.WorkBook
}

export function readWorkbook(data: ArrayBuffer): ParsedWorkbook {
  const wb = XLSX.read(data, {
    type: 'array',
    dense: true,
    cellHTML: false,
    cellStyles: false,
    cellFormula: false,
  })
  return { sheetNames: wb.SheetNames.slice(), wb }
}

function toCell(cell: XLSX.CellObject | undefined): Cell | undefined {
  if (!cell || cell.v === undefined) {
    if (cell && cell.t === 'e') return { v: null, isError: true, w: typeof cell.w === 'string' ? cell.w : '#ERROR' }
    return undefined
  }
  if (cell.t === 'e') return { v: null, isError: true, w: typeof cell.w === 'string' ? cell.w : '#ERROR' }
  if (cell.t === 'b') return { v: cell.v ? 1 : 0, isError: false }
  if (typeof cell.v === 'number' || typeof cell.v === 'string') {
    return { v: cell.v, isError: false, w: typeof cell.w === 'string' ? cell.w : undefined }
  }
  if (cell.v instanceof Date) return { v: cell.w ?? cell.v.toISOString().slice(0, 10), isError: false }
  return { v: String(cell.v), isError: false }
}

/** 读取 sheet 为 0 基网格；xlsx 0.18.5 的 dense 模式下 sheet 本身就是行数组 */
export function sheetGrid(
  pw: ParsedWorkbook,
  sheetName: string,
  maxRows = MAX_SCAN_ROWS,
  maxCols = MAX_SCAN_COLS,
): Grid {
  const ws = pw.wb.Sheets[sheetName]
  if (!ws) return []
  const grid: Grid = []
  if (Array.isArray(ws)) {
    const limit = Math.min(ws.length, maxRows)
    for (let r = 0; r < limit; r++) {
      const src = ws[r] as (XLSX.CellObject | undefined)[] | undefined
      if (!src) {
        grid.push([])
        continue
      }
      const out: (Cell | undefined)[] = []
      const cl = Math.min(src.length, maxCols)
      for (let c = 0; c < cl; c++) out.push(toCell(src[c]))
      grid.push(out)
    }
    return grid
  }
  // 兜底：稀疏模式（理论上 dense:true 不会走到这里）
  const ref = ws['!ref']
  if (!ref) return []
  const range = XLSX.utils.decode_range(ref)
  const rowEnd = Math.min(range.e.r, maxRows - 1)
  const colEnd = Math.min(range.e.c, maxCols - 1)
  for (let r = 0; r <= rowEnd; r++) {
    const out: (Cell | undefined)[] = []
    for (let c = 0; c <= colEnd; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      out.push(toCell(ws[addr] as XLSX.CellObject | undefined))
    }
    grid.push(out)
  }
  return grid
}
