import { KK_COL } from '../export/kkLayout'
import { KK_COL_COUNT, type MasterCell, type MasterRow } from './model'
import { quoteEaFor } from './quoteEa'

/**
 * 复制成表格贴进 Excel：列位置要和汇总表一一对上。
 *
 * - 只读账号看不到 O、P、Q、S，但汇总表 Excel 里这几列还在（只是隐藏）。复制时把它们丢掉，
 *   贴进去后 O 以后的内容会整体左移 4 列；所以夹在选中列中间的隐藏列照样占一列，内容留空。
 * - U 列对客价表格里不显示，复制时按 H 列和清洗等级现算（和导出 Excel 的公式结果一样），见 copyRowCells。
 * - 选整行复制从 B 列「批次」开始，不带 A 列序号（Zane 2026-10-30：贴到汇总表 B 列，A 列序号由表格自己续）。
 * - 剪贴板里同时放纯文本（TSV）和 HTML 表格：Excel、WPS 粘贴时用 HTML，带上汇总表的样子
 *   （蓝白隔行、Arial 14 号、居中、细边框、¥/$ 金额格式）；只认纯文本的地方（输入框、聊天框）照旧拿到 TSV。
 * - 格子里的换行（描述、表面处理里很常见）原样写出去：TSV 里按 Excel 自己复制时的写法用双引号包起来，
 *   HTML 里写成格内换行。
 */

/** 只读账号（Tony）看不到的列：和发给他的 Excel 一样隐藏 O、P、Q、S */
export const VIEWER_HIDDEN_COLS: ReadonlySet<number> = new Set([14, 15, 16, 18])

/**
 * 表格里谁都看不到的列：U 列对客价 Quote (EA)。网页上存的旧值不再对，所以不显示（Zane 2026-10-27）；
 * 复制时不拿存的旧值，按 H 列和清洗等级现算（Zane 2026-10-30）。
 */
export const ALWAYS_HIDDEN_COLS: ReadonlySet<number> = new Set([KK_COL.quoteEa])

const VIEWER_ALL_HIDDEN: ReadonlySet<number> = new Set([...VIEWER_HIDDEN_COLS, ...ALWAYS_HIDDEN_COLS])

/** 表格不显示的列：只读账号再加上 O、P、Q、S */
export function hiddenColsFor(readOnly: boolean): ReadonlySet<number> {
  return readOnly ? VIEWER_ALL_HIDDEN : ALWAYS_HIDDEN_COLS
}

/** 选整行复制从这一列开始：B 列「批次」（A 列序号不带） */
export const ROW_COPY_FIRST_COL = KK_COL.name

/**
 * 要复制的列（0 基、升序）：选中的可见列，加上左右最近的可见列都选中的隐藏列。
 * 整行复制时 B 列起都算选中，结果就是 B–AH；只点了 D、F 两列这种不连续的选法，
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

/**
 * 按 copyColumns 的列取出一行：U 列对客价按 H 列和清洗等级现算（H 空着或是文字时为空）；
 * 其余隐藏列一律留空，不把看不到的内容放进剪贴板
 */
export function copyRowCells(
  cells: readonly MasterCell[],
  cols: readonly number[],
  hiddenCols: ReadonlySet<number>,
): MasterCell[] {
  return cols.map((c) =>
    c === KK_COL.quoteEa ? quoteEaFor(cells).value : hiddenCols.has(c) ? null : (cells[c] ?? null),
  )
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

// ---- 带格式的 HTML 表格（照 KK询价汇总表20261012.xlsm 的「KK询价汇总」） ----

/** 隔行底色：表格样式 TableStyleMedium2 的浅蓝条（主题色 4472C4 淡 80%）和白条，第一行是蓝的 */
export const COPY_BAND_FILLS = ['#D9E1F2', '#FFFFFF'] as const

/** 每格共同的样子：Arial 14 号、水平垂直居中、细边框、不自动换行 */
const CELL_STYLE =
  'font-family:Arial;font-size:14pt;color:#000000;text-align:center;vertical-align:middle;' +
  'border:.5pt solid windowtext;white-space:nowrap'

// mso-number-format 照 Excel 自己存网页时的写法：引号写成 \0022，符号前加反斜杠
const NUM_FMT_TEXT = String.raw`\@` // 文字按文本贴：0099999、3-5、1/2 不会被 Excel 改成数字或日期
const NUM_FMT_GENERAL = 'General'
const NUM_FMT_YUAN = String.raw`\0022\00A5\0022\#\,\#\#0\.00` // "¥"#,##0.00
const NUM_FMT_USD = String.raw`\0022$\0022\#\,\#\#0\.00` // "$"#,##0.00

/** 原表里带货币格式的列：J、K、L（HC、SKW、CL）和 AG（YJ）是 ¥，U 列对客价是 $；其余是常规 */
const YUAN_COLS: ReadonlySet<number> = new Set([9, 10, 11, KK_COL.yj])

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function htmlCell(v: MasterCell | undefined, col: number, fill: string): string {
  let fmt = ''
  let body = ''
  if (typeof v === 'number' && Number.isFinite(v)) {
    fmt = col === KK_COL.quoteEa ? NUM_FMT_USD : YUAN_COLS.has(col) ? NUM_FMT_YUAN : NUM_FMT_GENERAL
    body = String(v)
  } else if (v !== null && v !== undefined && String(v) !== '') {
    fmt = NUM_FMT_TEXT
    body = String(v)
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, ' ')
      .split('\n')
      .map(htmlEscape)
      .join('<br style="mso-data-placement:same-cell">') // 格内换行，不拆成几行
  }
  const style = `${CELL_STYLE};background:${fill}${fmt ? `;mso-number-format:'${fmt}'` : ''}`
  // 底色、对齐再写一遍老式属性：不认行内样式的表格软件（如 LibreOffice）也有蓝白条
  return `<td style="${style}" bgcolor="${fill}" align="center" valign="middle">${body}</td>`
}

/**
 * 二维表 → 剪贴板 HTML：cols 是每一列在汇总表里的列号（定金额格式用），行按复制顺序蓝白相间。
 * 样式都写在格子上（不用 <style> 和 class）：浏览器把 HTML 放进剪贴板时会在外面再包一层，Excel 认行内样式最稳。
 */
export function toExcelHtml(rows: readonly (readonly MasterCell[])[], cols: readonly number[]): string {
  const trs = rows.map((r, i) => {
    const fill = COPY_BAND_FILLS[i % 2]!
    return `<tr>${cols.map((col, k) => htmlCell(r[k], col, fill)).join('')}</tr>`
  })
  return (
    '<meta charset="utf-8">' +
    `<table border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${trs.join('')}</table>`
  )
}

/** 一次复制放进剪贴板的内容：纯文本（TSV）+ 带格式的 HTML 表格 */
export interface CopyPayload {
  text: string
  html: string
}

/** 汇总表若干行里选中的格子 → 剪贴板内容（选列、框选、选行共用）：隐藏列夹在中间时占位，U 列填现算的对客价 */
export function cellsToClipboard(
  rows: readonly (readonly MasterCell[])[],
  isSelected: (col: number) => boolean,
  hiddenCols: ReadonlySet<number>,
): CopyPayload {
  const cols = copyColumns(isSelected, hiddenCols, KK_COL_COUNT)
  const matrix = rows.map((cells) => copyRowCells(cells, cols, hiddenCols))
  return { text: toExcelTsv(matrix), html: toExcelHtml(matrix, cols) }
}

/** 框选的一行：这一行的格子，和它落在哪几块格区里（每块的列区间 [c1, c2]，含端点） */
export interface RangeRow {
  cells: readonly MasterCell[]
  spans: readonly (readonly [number, number])[]
}

/**
 * 框选的几块格区 → 剪贴板内容（Zane 2026-10-31：再框一块接着加选）。
 * 行 = 落在任一块里的行（按显示顺序），列 = 任一块用到的列；某格不在这一行所在的块里就留空。
 * 几块列相同（如分几段框 D 列零件号）时就是上下接起来的一列；只有一块时和 cellsToClipboard 一样。
 */
export function cellRangesToClipboard(rows: readonly RangeRow[], hiddenCols: ReadonlySet<number>): CopyPayload {
  const inSpan = (spans: RangeRow['spans'], c: number) => spans.some(([a, b]) => c >= a && c <= b)
  const cols = copyColumns((c) => rows.some((r) => inSpan(r.spans, c)), hiddenCols, KK_COL_COUNT)
  const matrix = rows.map((r) =>
    copyRowCells(r.cells, cols, hiddenCols).map((v, k) => (inSpan(r.spans, cols[k]!) ? v : null)),
  )
  return { text: toExcelTsv(matrix), html: toExcelHtml(matrix, cols) }
}

/**
 * 汇总表整行 → 剪贴板内容（主表选行复制、比价页「总表格式」复制共用）：
 * B 列批次到 AH 列共 33 列，位置和汇总表 B 列起一一对上；隐藏列留空，U 列现算
 */
export function masterRowsToClipboard(rows: readonly MasterRow[], hiddenCols: ReadonlySet<number>): CopyPayload {
  return cellsToClipboard(
    rows.map((r) => r.cells),
    (c) => c >= ROW_COPY_FIRST_COL,
    hiddenCols,
  )
}
