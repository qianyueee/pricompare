import { describe, expect, it } from 'vitest'
import { parsePrice } from '@engine/normalize/price'
import { parseLeadTime } from '@engine/normalize/leadtime'
import type { Cell } from '@engine/types'

const cell = (v: string | number | null, isError = false, w?: string): Cell => ({ v, isError, w })

describe('parsePrice', () => {
  it('数字与货币文本清洗', () => {
    expect(parsePrice(cell(45), '', 'RMB')).toMatchObject({ status: 'ok', amount: 45, currency: 'RMB' })
    expect(parsePrice(cell('￥1,133.40'), '', 'RMB')).toMatchObject({ status: 'ok', amount: 1133.4, currency: 'RMB' })
    expect(parsePrice(cell('$935.00 '), '', 'RMB')).toMatchObject({ status: 'ok', amount: 935, currency: 'USD' })
  })
  it('TDB/待定 → pending；错误单元格 → invalid；空 → empty', () => {
    expect(parsePrice(cell('TDB'), '', 'RMB').status).toBe('pending')
    expect(parsePrice(cell('待定'), '', 'RMB').status).toBe('pending')
    expect(parsePrice(cell(null, true, '#REF!'), '', 'RMB')).toMatchObject({ status: 'invalid', raw: '#REF!' })
    expect(parsePrice(cell(''), '', 'RMB').status).toBe('empty')
    expect(parsePrice(undefined, '', 'RMB').status).toBe('empty')
    expect(parsePrice(cell('abc'), '', 'RMB').status).toBe('invalid')
  })
  it('币种优先级：单元格符号 > 表头 > 列默认', () => {
    expect(parsePrice(cell(12), 'US Vendor (US$)', 'RMB').currency).toBe('USD')
    expect(parsePrice(cell(12), 'Quote Each RMB', 'USD').currency).toBe('RMB')
    expect(parsePrice(cell('￥88'), 'US Vendor (US$)', 'USD').currency).toBe('RMB')
  })
})

describe('parseLeadTime', () => {
  const days = (v: string | number) => parseLeadTime(cell(v)).days
  it('真实样本的各种交期写法', () => {
    expect(days(22)).toBe(22)
    expect(days('22')).toBe(22)
    expect(days('3 weeks+cleaning')).toBe(21)
    expect(days('2-3 days')).toBe(3)
    expect(days('10-days')).toBe(10)
    expect(days('20Days')).toBe(20)
    expect(days('15Days/3 weeks+cleaning')).toBe(21)
    expect(days('4-5 days')).toBe(5)
    expect(days('2 days + cleaning')).toBe(2)
  })
  it('解析不了保留原文，days 为 null', () => {
    const lt = parseLeadTime(cell('明天提供报价'))
    expect(lt.days).toBeNull()
    expect(lt.raw).toBe('明天提供报价')
    expect(parseLeadTime(undefined)).toEqual({ raw: '', days: null })
  })
})
