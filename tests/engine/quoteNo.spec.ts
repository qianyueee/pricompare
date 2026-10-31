import { describe, expect, it } from 'vitest'
import { makeQuote } from '../fixtures/rows'
import {
  KK_COL,
  KK_COL_COUNT,
  applyMerge,
  applyMasterOp,
  kzQuoteNo,
  normalizeReceivedDate,
  planMerge,
  seqIndex,
  seqLetters,
  todayYmd,
  type MasterCell,
  type MasterData,
  type MergeOptions,
} from '@engine/index'

const mk = (vals: Record<number, MasterCell>) => {
  const cells = Array.from({ length: KK_COL_COUNT }, () => null as MasterCell)
  for (const [k, v] of Object.entries(vals)) cells[Number(k)] = v
  return { cells }
}
const base = (rows: { cells: MasterCell[] }[]): MasterData => ({
  rows,
  sheetName: 'KK询价汇总',
  passthrough: [],
  sourceFileName: null,
  importedAt: null,
})
const HC = { vendorSlot: 9, vendorId: 'hc', vendorDisplay: 'HC' }
const SKW = { vendorSlot: 10, vendorId: 'skw', vendorDisplay: 'SKW' }
const merge = (m: MasterData, quotes: ReturnType<typeof makeQuote>[], opts: MergeOptions) =>
  applyMerge(m, planMerge(m, quotes, opts))
const V = (m: MasterData) => m.rows.map((r) => r.cells[KK_COL.quoteNo])

describe('KZ 报价单号：字母序', () => {
  it('A…Z 之后接 AA、AB……（同 Excel 列名），可互逆', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(seqLetters)).toEqual([
      'A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA',
    ])
    for (let i = 0; i < 800; i++) expect(seqIndex(seqLetters(i))).toBe(i)
  })

  it('收到日期：几种写法都认，邮件日期按原文的日期取；认不出返回 null', () => {
    expect(normalizeReceivedDate('20261031')).toBe('20261031')
    expect(normalizeReceivedDate('2026-10-31')).toBe('20261031')
    expect(normalizeReceivedDate(' 2026/10/31 ')).toBe('20261031')
    expect(normalizeReceivedDate('2026-1-5')).toBe('20260105')
    expect(normalizeReceivedDate('2026-10-31T23:30:00+08:00')).toBe('20261031')
    expect(normalizeReceivedDate('2026-10-31 23:30')).toBe('20261031')
    for (const bad of ['', '2026103', '20261332', '2026-02-30', 'abc', '2026-10-31x', undefined, null]) {
      expect(normalizeReceivedDate(bad)).toBeNull()
    }
    expect(todayYmd(new Date(2026, 9, 31, 23, 59))).toBe('20261031')
  })
})

describe('KZ 报价单号：取号', () => {
  it('当天没有 → A；同组当天已有 → 沿用；别的组 → 当天最大字母的下一个；别的日期、KV 单号不算', () => {
    const m = base([
      mk({ 1: 'G1', 21: 'KV202610311' }),
      mk({ 1: 'G2', 21: 'KZ20261030C' }),
    ])
    expect(kzQuoteNo(m, 'G3', '20261031')).toBe('KZ20261031A')
    m.rows.push(mk({ 1: 'G3', 21: 'KZ20261031A' }), mk({ 1: 'G4', 21: 'KV1/KZ20261031C' }))
    expect(kzQuoteNo(m, 'G3', '20261031')).toBe('KZ20261031A')
    expect(kzQuoteNo(m, ' G4 ', '20261031')).toBe('KZ20261031C')
    expect(kzQuoteNo(m, 'G5', '20261031')).toBe('KZ20261031D') // B 空着也不回头用，免得和删掉的行重号
    expect(kzQuoteNo(m, 'G2', '20261031')).toBe('KZ20261031D') // G2 只有 10-30 的单号
  })

  it('Z 之后接 AA', () => {
    const m = base([mk({ 1: 'G', 21: 'KZ20261031Z' })])
    expect(kzQuoteNo(m, 'H', '20261031')).toBe('KZ20261031AA')
    m.rows.push(mk({ 1: 'H', 21: 'KZ20261031AA' }))
    expect(kzQuoteNo(m, 'I', '20261031')).toBe('KZ20261031AB')
  })
})

describe('KZ 报价单号：并入', () => {
  it('同组同一天共用一个单号（HC、SKW 先后回也一样）；下一组顺延；第二天新增的行用第二天的单号', () => {
    const d1 = { receivedDate: '2026-10-31' }
    let m = base([])
    m = merge(m, [makeQuote('P-1', { amount: 10 }), makeQuote('P-2', { amount: 20 })], { batch: 'G1', ...HC, ...d1 })
    expect(V(m)).toEqual(['KZ20261031A', 'KZ20261031A'])

    m = merge(m, [makeQuote('Q-1', { amount: 30 })], { batch: 'G2', ...HC, ...d1 })
    expect(V(m)[2]).toBe('KZ20261031B')

    // SKW 同一天回 G1：已有行的单号不变，SKW 多报的一行也用 G1 当天的单号
    m = merge(m, [makeQuote('P-1', { amount: 11 }), makeQuote('P-3', { amount: 33 })], { batch: 'G1', ...SKW, ...d1 })
    expect(m.rows[0]!.cells[10]).toBe(11)
    expect(V(m)).toEqual(['KZ20261031A', 'KZ20261031A', 'KZ20261031B', 'KZ20261031A'])

    // 第二天：G1 再补一行 → 第二天的 A；G2 的已有行填价 → 单号不变
    const d2 = { receivedDate: '20261101' }
    m = merge(m, [makeQuote('P-4', { amount: 44 })], { batch: 'G1', ...SKW, ...d2 })
    m = merge(m, [makeQuote('Q-1', { amount: 31 })], { batch: 'G2', ...SKW, ...d2 })
    expect(V(m)).toEqual(['KZ20261031A', 'KZ20261031A', 'KZ20261031B', 'KZ20261031A', 'KZ20261101A'])
  })

  it('只填 V 空着、这次写了价的行：历史单号不动，没价的行和跳过的行不填', () => {
    const m = base([
      mk({ 0: 1, 1: 'G', 3: 'A-1', 6: 10, 9: 100, 21: 'KV202610286' }),
      mk({ 0: 2, 1: 'G', 3: 'A-2', 6: 10, 9: 200 }),
      mk({ 0: 3, 1: 'G', 3: 'A-3', 6: 10, 10: 300 }),
    ])
    const plan = planMerge(
      m,
      [
        makeQuote('A-1', { amount: 90 }),
        makeQuote('A-2'), // 没识别出价格
        makeQuote('A-3', { amount: 300 }), // 和表里一样 → 跳过
      ],
      { batch: 'G', ...SKW, receivedDate: '20261031' },
    )
    expect(plan.skipCount).toBe(1)
    expect(V(applyMerge(m, plan))).toEqual(['KV202610286', null, null])
  })

  it('同批次修订：V 空着补当天单号，已有的不动', () => {
    const m = base([
      mk({ 0: 1, 1: 'G', 3: 'R-1', 6: 5, 9: 100 }),
      mk({ 0: 2, 1: 'G', 3: 'R-2', 6: 5, 9: 100, 21: 'KZ20261030A' }),
    ])
    const plan = planMerge(m, [makeQuote('R-1', { qty: 5, amount: 120 }), makeQuote('R-2', { qty: 5, amount: 130 })], {
      batch: 'G',
      ...HC,
      receivedDate: '20261031',
    })
    expect(plan.reviseCount).toBe(2)
    expect(V(applyMerge(m, plan))).toEqual(['KZ20261031A', 'KZ20261030A'])
  })

  it('没给收到日期（或认不出）就用今天', () => {
    const today = todayYmd()
    for (const receivedDate of [undefined, 'not a date']) {
      const m = merge(base([]), [makeQuote('T-1', { amount: 1 })], { batch: 'G', ...HC, receivedDate })
      expect(V(m)).toEqual([`KZ${today}A`])
    }
  })

  it('服务在最新总表上重新规划：别人先占了当天的字母，后到的并入顺延', () => {
    const opts = { ...HC, receivedDate: '20261031' }
    const m0 = base([])
    const m1 = applyMasterOp(m0, { kind: 'merge', quotes: [makeQuote('X-1', { amount: 1 })], options: { batch: 'G1', ...opts } }).master
    const m2 = applyMasterOp(m1, { kind: 'merge', quotes: [makeQuote('Y-1', { amount: 2 })], options: { batch: 'G2', ...opts } }).master
    expect(V(m2)).toEqual(['KZ20261031A', 'KZ20261031B'])
  })
})
