import { KK_COL } from '../export/kkLayout'
import type { MasterCell } from './model'

/**
 * 对客美元报价 U 列「Quote (EA)」的公式（比价页「导出表格 → 总表格式」用）：
 * H 列 Quote (each)（人民币）÷ 6.7 换成美元，按 Z 列清洗等级乘系数（30 级 ×4.2、20 级 ×4.5、10 级 ×4.8，没写等级按 ×4.2），
 * 再向上取整到十位；取整后落在整百附近（尾数 00 或 10，如 300、310）的归到下面的 90（290）。
 * 例：658.2 → 660；296 → 300 → 290；304 → 310 → 290；1005 → 1010 → 990；95 → 100 → 90；8 → 10。
 */
export const QUOTE_EA_RATE = 6.7

/** 清洗等级 → 系数 */
export const QUOTE_EA_MULTIPLIERS: Readonly<Record<CleaningGrade, number>> = { 30: 4.2, 20: 4.5, 10: 4.8 }

/** 清洗要求里没写 10/20/30 级（不详、0099999、CLASS GP、空着等）时的系数：按 30 级算（Zane 2026-10-27） */
export const QUOTE_EA_DEFAULT_MULTIPLIER = QUOTE_EA_MULTIPLIERS[30]

export type CleaningGrade = 10 | 20 | 30

const GRADE_RES = [
  /(?:^|\D)(10|20|30)\s*级/g, // 30级、10级HV（不用后行断言：旧版 Safari 不认）
  /LEVEL?\s*[:#-]?\s*(10|20|30)(?!\d)/gi, // LEVEL 20、Level 30、LEVE 10（原表里有这种笔误）
  /CLASS\s*[:#-]?\s*(10|20|30)(?!\d)/gi,
]

/** 从清洗要求原文里认出 10/20/30 级；认不出返回 null。同一格写了几个等级时取最严的（数字最小） */
export function parseCleaningGrade(spec: MasterCell): CleaningGrade | null {
  if (spec === null || spec === undefined) return null
  const s = String(spec)
  let best: CleaningGrade | null = null
  for (const re of GRADE_RES) {
    for (const m of s.matchAll(re)) {
      const g = Number(m[1]) as CleaningGrade
      if (best === null || g < best) best = g
    }
  }
  return best
}

/** 去掉 H/6.7*4.2 这类浮点误差（670/6.7*4.2 不应算成 420.00000000000006 再进到 430） */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6

/** 美元 → 对客报价：向上取到十位；尾数 00、10（且 ≥100）归到下面的 90 */
export function roundQuoteEa(usd: number): number {
  const t = Math.ceil(round6(usd) / 10) * 10
  const m = t % 100
  return t >= 100 && m <= 10 ? t - m - 10 : t
}

/**
 * 一行的对客报价：系数按清洗等级（认不出按 30 级）；value 是 H 为数字时算好的美元价，
 * H 空着或写的是文字时为 null——公式照样写，导出后在 Excel 里填上 H 就自动算出来
 */
export function quoteEaFor(cells: readonly MasterCell[]): { value: number | null; multiplier: number } {
  const h = cells[KK_COL.quoteEach]
  const grade = parseCleaningGrade(cells[KK_COL.cleaningSpec] ?? null)
  const multiplier = grade === null ? QUOTE_EA_DEFAULT_MULTIPLIER : QUOTE_EA_MULTIPLIERS[grade]
  const value =
    typeof h === 'number' && Number.isFinite(h) && h > 0 ? roundQuoteEa((h / QUOTE_EA_RATE) * multiplier) : null
  return { value, multiplier }
}

/**
 * U 列的 Excel 公式（不带等号）。只用 Excel 2010 起都有的函数（不用 LET），WPS / Numbers 也能算；
 * 汇率和系数直接写在公式里，打开就看得到；H 空着或是文字（如 TDB）时显示为空而不是 #VALUE!。
 */
export function quoteEaFormula(hRef: string, multiplier: number): string {
  const t = `CEILING(ROUND(${hRef}/${QUOTE_EA_RATE}*${multiplier},6),10)`
  return `IF(ISNUMBER(${hRef}),${t}-IF(AND(${t}>=100,MOD(${t},100)<=10),MOD(${t},100)+10,0),"")`
}
