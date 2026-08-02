import { describe, expect, it } from 'vitest'
import {
  FILE_A_PRICES,
  FILE_B_PRICES,
  FIXTURE_PNS,
  makeFileA,
  makeFileB,
} from '../fixtures/buildFixtures'
import { makeQuote } from '../fixtures/rows'
import { SEED_VENDORS, analyzeSheet, buildCompare, readWorkbook } from '@engine/index'

describe('buildCompare：真实结构固件 A+B 对比', () => {
  it('key 对齐、最低价标记、价差、合计', async () => {
    const a = await analyzeSheet(readWorkbook(await makeFileA()), { fileName: 'KV.xlsx', vendors: SEED_VENDORS })
    const b = await analyzeSheet(readWorkbook(await makeFileB()), { fileName: 'HCQuote.xlsx', vendors: SEED_VENDORS })
    const result = buildCompare(
      [
        { vendorId: 'skw', vendorDisplay: 'SKW', rows: a.rows },
        { vendorId: 'hc', vendorDisplay: 'HC', rows: b.rows },
      ],
      6.5,
    )
    expect(result.rows).toHaveLength(9)
    const first = result.rows.find((r) => r.pn === FIXTURE_PNS[0])!
    expect(first.okCount).toBe(2)
    expect(first.cells['skw']).toMatchObject({ rmbEquivalent: 45, isMin: true, deltaPct: 0 })
    expect(first.cells['hc']!.isMin).toBe(false)
    expect(first.cells['hc']!.deltaPct).toBeCloseTo((56.7 - 45) / 45)
    // 第 3 个零件 HC 更便宜（17 vs 225）
    const third = result.rows.find((r) => r.pn === FIXTURE_PNS[2])!
    expect(third.cells['hc']).toMatchObject({ rmbEquivalent: 17, isMin: true })
    expect(third.cells['skw']!.isMin).toBe(false)
    // 合计
    const sumA = FILE_A_PRICES.reduce((s, v) => s + v, 0)
    const sumBest = FIXTURE_PNS.reduce((s, _, i) => s + Math.min(FILE_A_PRICES[i]!, FILE_B_PRICES[i]!), 0)
    const skwTotal = result.totals.perVendor.find((v) => v.vendorId === 'skw')!
    expect(skwTotal.sumUnit).toBeCloseTo(sumA)
    expect(skwTotal.missingRows).toBe(0)
    expect(result.totals.bestUnitSum).toBeCloseTo(sumBest)
    expect(result.totals.comparableRows).toBe(9)
  })
})

describe('buildCompare：边界行为', () => {
  it('仅一家报价不标最低；数量阶梯各成一行；重复报价告警；USD 换算', () => {
    const result = buildCompare(
      [
        {
          vendorId: 'v1',
          vendorDisplay: '一号',
          rows: [
            makeQuote('P-1', { qty: 1, amount: 100 }),
            makeQuote('P-1', { qty: 5, amount: 80 }),
            makeQuote('P-2', { amount: 50 }),
            makeQuote('P-3', { amount: 30 }),
            makeQuote('P-3', { amount: 33 }), // 同 key 重复
          ],
        },
        {
          vendorId: 'v2',
          vendorDisplay: '二号',
          rows: [
            makeQuote('P-1', { qty: 1, amount: 12, currency: 'USD' }), // 12×6.5=78 < 100
            makeQuote('P-2', { pending: true }),
          ],
        },
      ],
      6.5,
    )
    const tier1 = result.rows.find((r) => r.pn === 'P-1' && r.qty === 1)!
    const tier5 = result.rows.find((r) => r.pn === 'P-1' && r.qty === 5)!
    expect(tier1.cells['v2']).toMatchObject({ rmbEquivalent: 78, isMin: true })
    expect(tier1.cells['v1']!.deltaPct).toBeCloseTo((100 - 78) / 78)
    // 阶梯行独立：qty=5 只有 v1 报价 → 仅一家，不标最低
    expect(tier5.singleQuote).toBe(true)
    expect(tier5.cells['v1']!.isMin).toBe(false)
    // pending 不参与最低价：P-2 实际只有 v1 有效
    const p2 = result.rows.find((r) => r.pn === 'P-2')!
    expect(p2.singleQuote).toBe(true)
    expect(p2.cells['v2']!.price.status).toBe('pending')
    // 重复 key 告警且取后一行
    expect(result.warnings.some((w) => w.includes('重复'))).toBe(true)
    const p3 = result.rows.find((r) => r.pn === 'P-3')!
    expect(p3.cells['v1']!.rmbEquivalent).toBe(33)
  })
})
