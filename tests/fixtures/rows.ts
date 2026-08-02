import type { Currency, PriceValue, QuoteRow } from '@engine/types'

export interface MakeQuoteOpts {
  rev?: string
  qty?: number | null
  amount?: number
  pending?: boolean
  currency?: Currency
  lead?: string
  leadDays?: number | null
  quoteNo?: string
  description?: string
  material?: string
  remark?: string
}

/** 测试用 QuoteRow 快速构造 */
export function makeQuote(pn: string, o: MakeQuoteOpts = {}): QuoteRow {
  const currency = o.currency ?? 'RMB'
  let price: PriceValue
  if (o.pending) price = { status: 'pending', currency, raw: 'TDB' }
  else if (o.amount !== undefined) price = { status: 'ok', amount: o.amount, currency, raw: String(o.amount) }
  else price = { status: 'empty', currency, raw: '' }
  return {
    pn,
    rev: o.rev ?? 'AA',
    qty: o.qty === undefined ? 10 : o.qty,
    price,
    leadTime: { raw: o.lead ?? '', days: o.leadDays ?? null },
    description: o.description ?? `DESC ${pn}`,
    material: o.material ?? '',
    surfaceFinish: '',
    cleaningSpec: '',
    process: '',
    size: '',
    quoteNo: o.quoteNo ?? '',
    remark: o.remark ?? '',
    basePn: '',
    partType: '',
    sourceRow: 2,
  }
}
