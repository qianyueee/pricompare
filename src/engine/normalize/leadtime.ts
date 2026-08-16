import type { Cell, LeadTime } from '../types'

/**
 * 抓取 "数字(-数字)?单位" 片段：
 * "22" → 22 天；"3 weeks+cleaning" → 21；"2-3 days" → 3；"10-days" → 10；
 * "15Days/3 weeks+cleaning" → 21（多段取最大）；"明天提供报价" → null（无数字+单位）。
 */
const SEG_RE =
  /(\d+(?:\.\d+)?)(?:\s*[-~～至到]\s*(\d+(?:\.\d+)?))?[\s-]*(天|日|days?|d\b|周|星期|weeks?|wks?|w\b|个月|月|months?|mo\b)?/giu

/**
 * 展示/导出用交期文本：纯数字补单位（"22" → "22Days"，与汇总表 "15Days" 惯例一致），
 * 其余写法（"3 weeks+cleaning"、"明天提供报价"）原样保留。
 */
export function formatLeadTime(lt: LeadTime): string {
  if (/^\d+(\.\d+)?$/.test(lt.raw)) return `${lt.raw}Days`
  return lt.raw
}

export function parseLeadTime(cell: Cell | undefined): LeadTime {
  if (!cell || cell.v === null || cell.v === undefined) return { raw: '', days: null }
  if (cell.isError) return { raw: cell.w ?? '#ERROR', days: null }
  if (typeof cell.v === 'number') {
    return Number.isFinite(cell.v)
      ? { raw: cell.w ?? String(cell.v), days: cell.v }
      : { raw: String(cell.v), days: null }
  }
  const raw = String(cell.v).trim()
  if (raw === '') return { raw: '', days: null }
  let max: number | null = null
  for (const m of raw.matchAll(SEG_RE)) {
    if (!m[1]) continue
    const hi = m[2] ? Number(m[2]) : Number(m[1])
    const unit = (m[3] ?? '').toLowerCase()
    const factor = /周|星期|w/.test(unit) ? 7 : /月|mo/.test(unit) ? 30 : 1
    const days = hi * factor
    if (Number.isFinite(days) && (max === null || days > max)) max = days
  }
  return { raw, days: max }
}
