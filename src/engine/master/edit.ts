import type { MasterCell, MasterData, MasterRow } from './model'

/**
 * 汇总表结构性编辑（供界面选区操作调用，全部不可变更新）：
 * - 删除整行：行移除后 A 列序号顺序重排（数字 A 从头连续，占位行一并顺延；非数字 A 原样保留）
 * - 清空单元格：Excel Delete 语义，内容置空但不动行列结构；A 列序号受保护
 * 导出侧无需配合：补丁导出按 max(当前, 原表) 行数逐格比对，删行后的尾部行会被置空。
 */

/** A 列序号重排：数字（或可转数字）的 A 依出现顺序 1..n 重排，其余原样 */
function renumberA(rows: MasterRow[]): MasterRow[] {
  let n = 0
  return rows.map((row) => {
    const a = row.cells[0]
    const num = Number(String(a ?? '').trim())
    if (a === null || String(a).trim() === '' || !Number.isFinite(num)) return row
    n += 1
    if (num === n) return row
    const cells = [...row.cells]
    cells[0] = n
    return { cells }
  })
}

export function deleteMasterRows(master: MasterData, rowIdxs: number[]): MasterData {
  const drop = new Set(rowIdxs)
  const rows = renumberA(master.rows.filter((_, i) => !drop.has(i)))
  return { ...master, rows }
}

/** 清空指定格（col 0 序号恒排除；越界行/列安全忽略） */
export function clearMasterCells(
  master: MasterData,
  targets: { rowIndex: number; cols: number[] }[],
): MasterData {
  const byRow = new Map<number, number[]>()
  for (const t of targets) {
    if (!master.rows[t.rowIndex]) continue
    const cols = t.cols.filter((c) => c > 0 && c < master.rows[t.rowIndex]!.cells.length)
    if (cols.length === 0) continue
    byRow.set(t.rowIndex, [...(byRow.get(t.rowIndex) ?? []), ...cols])
  }
  if (byRow.size === 0) return master
  const rows = master.rows.map((row, i) => {
    const cols = byRow.get(i)
    if (!cols) return row
    const cells: MasterCell[] = [...row.cells]
    for (const c of cols) cells[c] = null
    return { cells }
  })
  return { ...master, rows }
}
