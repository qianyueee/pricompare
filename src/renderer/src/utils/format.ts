import type { Currency } from '@engine/types'

export function fmtNum(amount: number): string {
  return amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtMoney(amount: number, currency: Currency): string {
  return currency === 'USD' ? `$${fmtNum(amount)}` : `¥${fmtNum(amount)}`
}

export function fmtPct(p: number): string {
  return `${p > 0 ? '+' : ''}${(p * 100).toFixed(1)}%`
}

export function todayYmd(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}
