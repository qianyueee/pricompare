import { KK_COL_COUNT, type MasterCell, type MasterRow } from './model'

/**
 * 复制成表格贴进 Excel：列位置要和汇总表一一对上。
 *
 * - 只读账号看不到 O、P、Q、S，但汇总表 Excel 里这几列还在（只是隐藏）。复制时把它们丢掉，
 *   贴进去后 O 以后的内容会整体左移 4 列；所以夹在选中列中间的隐藏列照样占一列，内容留空。
 * - 格子里的换行（描述、表面处理里很常见）原样写出去，Excel 会把一行拆成几行；
 *   按 Excel 自己复制时的写法，有换行的格子用双引号包起来。
 */

/** 只读账号（Tony）看不到的列：和发给他的 Excel 一样隐藏 O、P、Q、S */
export const VIEWER_HIDDEN_COLS: ReadonlySet<number> = new Set([14, 15, 16, 18])

/**
 * 要复制的列（0 基、升序）：选中的可见列，加上左右最近的可见列都选中的隐藏列。
 * 整行复制时所有列都算选中，结果就是全部列；只点了 D、F 两列这种不连续的选法，
 * 中间没选的可见列照旧跳过（和 Excel 复制不连续选区一样挤在一起）。
 */
export function copyColumns(
  isSelected: (col: number) => boolean,
  hiddenCols: ReadonlySet<number>,
  colCount: number,
): number[] {
  const visible: number[] = []
  for (let c = 0; c < colCount; c++) if (!hiddenCols.has(c)) visible.push(c)
  const out: number[] = []
  let v = 0 // visible[v] 是 c 右边（含 c）最近的可见列
  for (let c = 0; c < colCount; c++) {
    while (v < visible.length && visible[v]! < c) v++
    if (!hiddenCols.has(c)) {
      if (isSelected(c)) out.push(c)
      continue
    }
    const left = v > 0 ? visible[v - 1] : undefined
    const right = visible[v]
    if (left !== undefined && right !== undefined && isSelected(left) && isSelected(right)) out.push(c)
  }
  return out
}

/** 按 copyColumns 的列取出一行：隐藏列一律留空，不把看不到的内容放进剪贴板 */
export function copyRowCells(
  cells: readonly MasterCell[],
  cols: readonly number[],
  hiddenCols: ReadonlySet<number>,
): MasterCell[] {
  return cols.map((c) => (hiddenCols.has(c) ? null : (cells[c] ?? null)))
}

/** 一格 → Excel 能原样认回的文本：制表符换成空格；有换行或以双引号开头时用双引号包起来 */
export function tsvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v).replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
  if (s.includes('\n') || s.startsWith('"')) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** 二维表 → 剪贴板 TSV（列用制表符、行用换行分隔），可直接粘贴进 Excel */
export function toExcelTsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((r) => r.map(tsvCell).join('\t')).join('\n')
}

/** 汇总表整行 → 剪贴板 TSV：34 列位置不变，隐藏列留空（主表选行复制、比价页「总表格式」复制共用） */
export function masterRowsToTsv(rows: readonly MasterRow[], hiddenCols: ReadonlySet<number>): string {
  const cols = copyColumns(() => true, hiddenCols, KK_COL_COUNT)
  return toExcelTsv(rows.map((r) => copyRowCells(r.cells, cols, hiddenCols)))
}
