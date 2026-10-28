import { KK_COL, KK_VENDOR_COLS } from '../export/kkLayout'
import type { MasterCell } from './model'

/**
 * H 列 Quote (each)（人民币）= 这一行各家供应商列（I–N、AG）里拿到的报价取平均，向上取整到个位
 * （Zane 2026-10-28）。只算存成数字的价：TDB、"无"、"US$50" 这类文字不算。
 *
 * 并入新报价、改供应商价时这一行的 H 自动重算（见 merge.ts、ops.ts）；手改 H 可以，
 * 但这一行的供应商价再变时会按平均重算。U 列对客价导出时按 H 写公式，跟着变。
 */

/** 去掉浮点误差，免得 (0.1+0.2)*10 这种算成 3.0000000000000004 再进到 4 */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6

/** 算进平均的报价：大于 0 的数字；文字、TDB、0 都不算 */
const priceOf = (v: MasterCell | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

/** 一行的平均价 H：没有任何数字报价时为 null */
export function averageQuoteEach(cells: readonly MasterCell[]): number | null {
  let sum = 0
  let n = 0
  for (const { col } of KK_VENDOR_COLS) {
    const v = priceOf(cells[col])
    if (v === null) continue
    sum += v
    n += 1
  }
  return n === 0 ? null : Math.ceil(round6(sum / n))
}

/**
 * 供应商列从 before 变成 after 后 H 该写的值；不用改时为 undefined。
 * - 数字报价没变（只是 TDB、"无" 这类文字进出）：H 不动
 * - 还有数字报价：H = 平均价
 * - 报价全没了：H 原来就是旧报价的平均价才清空，手填的数字和文字说明留着
 */
export function nextQuoteEach(
  before: readonly MasterCell[],
  after: readonly MasterCell[],
): MasterCell | undefined {
  if (KK_VENDOR_COLS.every(({ col }) => priceOf(before[col]) === priceOf(after[col]))) return undefined
  const cur = after[KK_COL.quoteEach] ?? null
  const avg = averageQuoteEach(after)
  if (avg !== null) return avg === cur ? undefined : avg
  const prev = averageQuoteEach(before)
  return prev !== null && cur === prev ? null : undefined
}

/**
 * 整表补算 H（一次性补旧数据用，CLI recalc-h）：返回要改的格。
 * onlyEmpty：只补 H 空着（或 TDB/待定 占位）的行；否则已有的数字 H 也换成平均价。
 * H 里写的文字说明（如「总价850约100张」）两种都不动。
 */
export function recalcQuoteEachChanges(
  rows: readonly { cells: readonly MasterCell[] }[],
  onlyEmpty: boolean,
): { row: number; from: MasterCell; to: number }[] {
  const out: { row: number; from: MasterCell; to: number }[] = []
  rows.forEach((r, i) => {
    const avg = averageQuoteEach(r.cells)
    if (avg === null) return
    const h = r.cells[KK_COL.quoteEach] ?? null
    const empty = h === null || /^(|tdb|tbd|待定)$/i.test(String(h).trim())
    if (!empty && (onlyEmpty || typeof h !== 'number')) return
    if (h === avg) return
    out.push({ row: i, from: h, to: avg })
  })
  return out
}
