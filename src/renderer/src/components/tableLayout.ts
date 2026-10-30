import type { MasterCell, MasterRow } from '@engine/index'

/**
 * 汇总大表的版面计算（纯函数，单测见 tests/renderer/tableLayout.spec.ts）：
 * - 只画看得见的行：几千行全画出来有近十万个格子，拖选每走一格都要几百毫秒；
 *   按滚动位置只画屏幕上那几十行，上下各多画一些，其余用等高的空行占位，滚动条照旧；
 * - 列宽按全表内容一次算好、固定下来（table-layout: fixed）：只画一部分行时，
 *   列宽不能再由「画出来的那些行」决定，否则一滚动列宽就跳。
 */

/** 一行的高度（像素）：12px 字、16px 行高、上下 2px 内边距、1px 下边框；编辑框也是这个高度 */
export const ROW_H = 21
/** 看得见的行上下各多画几行：滚得快时不露白 */
export const OVERSCAN = 20
/** 画的行区间按这个行数取整：小幅滚动不用重画 */
export const WINDOW_STEP = 10

export interface RowWindow {
  /** 第一行（可见序号，含） */
  start: number
  /** 最后一行之后（不含） */
  end: number
}

/** 滚动位置 → 要画的行区间 [start, end) */
export function rowWindow(scrollTop: number, viewportH: number, rowH: number, total: number): RowWindow {
  const top = Math.max(0, scrollTop)
  const first = Math.floor(top / rowH)
  const last = Math.ceil((top + Math.max(0, viewportH)) / rowH)
  const end = Math.max(0, Math.min(total, Math.ceil((last + OVERSCAN) / WINDOW_STEP) * WINDOW_STEP))
  const start = Math.min(end, Math.max(0, Math.floor((first - OVERSCAN) / WINDOW_STEP) * WINDOW_STEP))
  return { start, end }
}

/** 格子左右内边距（px-1.5 两边各 6px）加右边框 1px，再留 1px 余量 */
export const CELL_PAD = 14

export interface ColumnSpec {
  /** 最窄（原来的 minWidth） */
  min: number
  /** 最宽（原来的 maxWidth = 最窄 × 1.6）：再长的内容省略号截断，悬停看全文 */
  max: number
  /** 表头文字需要的宽度（表头不截断） */
  header: number
}

/** 量一格文字的宽度（像素，不含内边距） */
export type MeasureText = (text: string, col: number) => number

/** 比这个还窄的字没有：字数 × 这个数已经超过最宽时不用再量 */
const NARROWEST_CHAR_PX = 2.5

function cellText(v: MasterCell | undefined): string {
  return v === null || v === undefined ? '' : String(v)
}

/** 一行每列的内容宽度（已截到该列最宽）；按行对象缓存，改一格只重量那一行 */
function rowContentWidths(
  row: MasterRow,
  specs: readonly ColumnSpec[],
  measure: MeasureText,
  cache: WeakMap<MasterRow, Float32Array>,
): Float32Array {
  const hit = cache.get(row)
  if (hit) return hit
  const out = new Float32Array(specs.length)
  for (let c = 0; c < specs.length; c++) {
    const text = cellText(row.cells[c])
    if (text === '') continue
    const cap = specs[c]!.max - CELL_PAD
    out[c] = text.length * NARROWEST_CHAR_PX >= cap ? cap : Math.min(cap, measure(text, c))
  }
  cache.set(row, out)
  return out
}

/** 每列的宽度：内容最宽的那格（加内边距），夹在 [最窄, 最宽] 之间，且不比表头窄 */
export function columnWidths(
  rows: readonly MasterRow[],
  specs: readonly ColumnSpec[],
  measure: MeasureText,
  cache: WeakMap<MasterRow, Float32Array>,
): number[] {
  const content = new Float32Array(specs.length)
  for (const row of rows) {
    const w = rowContentWidths(row, specs, measure, cache)
    for (let c = 0; c < specs.length; c++) if (w[c]! > content[c]!) content[c] = w[c]!
  }
  return specs.map((s, c) => {
    const body = content[c]! > 0 ? Math.min(s.max, Math.max(s.min, content[c]! + CELL_PAD)) : s.min
    return Math.ceil(Math.max(body, s.header))
  })
}

/** 冻结列的左偏移：前面各列宽度累加 */
export function stickyLefts(widths: readonly number[], count: number): number[] {
  const out: number[] = []
  let x = 0
  for (let c = 0; c < count; c++) {
    out.push(x)
    x += widths[c] ?? 0
  }
  return out
}
