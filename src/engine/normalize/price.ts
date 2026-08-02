import type { Cell, Currency, PriceValue } from '../types'

const PENDING_RE = /^(tdb|tbd|待定|待报价?|pending|另报|后补|再报)$/i
const CURRENCY_STRIP_RE = /[\uffe5\u00a5$\u20ac,\uff0c\s\u00a0]/g

export function detectCurrencyFromText(text: string): Currency | undefined {
  const n = String(text ?? '').toLowerCase()
  if (/us\$|usd|美元|美金/.test(n)) return 'USD'
  if (/rmb|￥|人民币|cny|元/.test(n)) return 'RMB'
  return undefined
}

/**
 * 价格清洗：数字直接用；文本去 ￥/¥/$/逗号/nbsp 后转数字；
 * TDB/TBD/待定 → pending；#REF! 等错误单元格 → invalid；空 → empty。
 * 币种优先级：单元格符号 > 表头文字 > 列默认。
 */
export function parsePrice(
  cell: Cell | undefined,
  headerText: string,
  defaultCurrency: Currency,
): PriceValue {
  const headerCurrency = detectCurrencyFromText(headerText)
  const fallback = headerCurrency ?? defaultCurrency
  if (!cell) return { status: 'empty', currency: fallback, raw: '' }
  if (cell.isError) return { status: 'invalid', currency: fallback, raw: cell.w ?? '#ERROR' }
  if (cell.v === null || cell.v === undefined) return { status: 'empty', currency: fallback, raw: '' }
  if (typeof cell.v === 'number') {
    return Number.isFinite(cell.v)
      ? { status: 'ok', amount: cell.v, currency: fallback, raw: cell.w ?? String(cell.v) }
      : { status: 'invalid', currency: fallback, raw: String(cell.v) }
  }
  const raw = String(cell.v).trim()
  if (raw === '') return { status: 'empty', currency: fallback, raw: '' }
  const cleaned = raw.replace(CURRENCY_STRIP_RE, '')
  if (PENDING_RE.test(cleaned)) return { status: 'pending', currency: fallback, raw }
  const num = Number(cleaned)
  if (cleaned !== '' && Number.isFinite(num)) {
    const symbolCurrency: Currency | undefined = /[￥¥]/.test(raw)
      ? 'RMB'
      : /\$/.test(raw)
        ? 'USD'
        : undefined
    return { status: 'ok', amount: num, currency: symbolCurrency ?? fallback, raw }
  }
  return { status: 'invalid', currency: fallback, raw }
}
