import { describe, expect, it } from 'vitest'
import {
  FILE_A_PRICES,
  FILE_B_PRICES,
  FIXTURE_PNS,
  makeFileA,
  makeFileB,
  makeFileC,
  makeMultiSheet,
} from '../fixtures/buildFixtures'
import { SEED_VENDORS, analyzeSheet, pickBestSheet, readWorkbook } from '@engine/index'

describe('解析管线：KV 风格（文件 A，表头第 1 行，价格 H/K 双列）', () => {
  it('自动识别表头、价格列、剔除宏垃圾行、猜测供应商', async () => {
    const pw = readWorkbook(await makeFileA())
    const a = await analyzeSheet(pw, { fileName: 'KV202607133_报价_0713.xlsx', vendors: SEED_VENDORS })
    expect(a.sheetName).toBe('Cost 2021A')
    expect(a.headerRow).toBe(0)
    expect(a.needsManualHeader).toBe(false)
    expect(a.mapping.priceCol).toBe(7) // H "Quote(each)"（与 K SKW 同值，同义词列优先）
    expect(a.mapping.priceCurrency).toBe('RMB')
    expect(a.rows).toHaveLength(9)
    expect(a.rows[0]).toMatchObject({ pn: FIXTURE_PNS[0], rev: 'AA', qty: 10, quoteNo: 'KV202607133' })
    expect(a.rows[0]!.price).toMatchObject({ status: 'ok', amount: FILE_A_PRICES[0] })
    expect(a.rows[0]!.leadTime).toMatchObject({ raw: '3 weeks+cleaning', days: 21 })
    expect(a.rows[4]!.remark).toBe('报价不含磁铁')
    expect(a.rows.map((r) => r.pn)).toEqual(FIXTURE_PNS)
    expect(a.warnings.some((w) => w.includes('跳过'))).toBe(true)
    expect(a.vendorGuess.vendorId).toBe('skw')
    // K 列 SKW 应作为候选出现（供人工改选）
    expect(a.candidates.some((c) => c.col === 10)).toBe(true)
  })
})

describe('解析管线：HC 风格（文件 B，表头第 3 行，#REF!，垃圾列）', () => {
  it('表头行 3、价格列 J、错误单元格计入警告、猜测 HC', async () => {
    const pw = readWorkbook(await makeFileB())
    const a = await analyzeSheet(pw, {
      fileName: 'HCQuote20260711_KT20260711B.xlsx',
      vendors: SEED_VENDORS,
    })
    expect(a.headerRow).toBe(2)
    expect(a.needsManualHeader).toBe(false)
    expect(a.mapping.priceCol).toBe(9) // J "Quote Each RMB"（空的 H 模板列要让位）
    expect(a.rows).toHaveLength(9)
    expect(a.rows[0]!.price).toMatchObject({ status: 'ok', amount: FILE_B_PRICES[0], currency: 'RMB' })
    expect(a.rows[0]!.leadTime.days).toBe(22)
    expect(a.rows[0]!.quoteNo).toBe('KT20260711B')
    // " 2" 等垃圾列不进映射
    expect(a.mapping.map[10]).toBeUndefined()
    expect(a.warnings.some((w) => w.includes('#REF!') || w.includes('错误'))).toBe(true)
    expect(a.vendorGuess.vendorId).toBe('hc')
  })
})

describe('解析管线：KK 汇总风格（文件 C，￥文本价 / TDB / $价 / 阶梯数量）', () => {
  it('阶梯行独立保留，价格清洗正确', async () => {
    const pw = readWorkbook(await makeFileC())
    const a = await analyzeSheet(pw, { fileName: 'HC_0717.xlsx', vendors: SEED_VENDORS })
    expect(a.rows).toHaveLength(5)
    expect(a.mapping.priceCol).toBe(9) // J "HC"（唯一有值的供应商列）
    expect(a.rows[0]!.price).toMatchObject({ status: 'ok', amount: 1360, currency: 'RMB' })
    expect(a.rows[1]!.price.amount).toBeCloseTo(1133.4)
    expect(a.rows[2]!.price).toMatchObject({ status: 'ok', amount: 680 })
    expect(a.rows.slice(0, 3).map((r) => r.qty)).toEqual([1, 2, 5])
    expect(a.rows[3]!.price.status).toBe('pending')
    expect(a.rows[4]!.price).toMatchObject({ status: 'ok', amount: 935, currency: 'USD' })
    expect(a.rows[4]!.leadTime.days).toBe(3)
  })
})

describe('多 sheet 与指纹', () => {
  it('自动选表头得分最高的 sheet；中文表头可识别', async () => {
    const pw = readWorkbook(await makeMultiSheet())
    expect(pickBestSheet(pw).sheetName).toBe('Quote')
    const a = await analyzeSheet(pw, { fileName: 'other.xlsx', vendors: SEED_VENDORS })
    expect(a.sheetName).toBe('Quote')
    expect(a.rows).toHaveLength(2)
    expect(a.rows[0]!.price).toMatchObject({ status: 'ok', amount: 120, currency: 'RMB' })
    expect(a.rows[0]!.leadTime.days).toBe(7)
  })
  it('同结构文件指纹一致，不同结构不同', async () => {
    const a1 = await analyzeSheet(readWorkbook(await makeFileA()), { fileName: 'a.xlsx', vendors: SEED_VENDORS })
    const a2 = await analyzeSheet(readWorkbook(await makeFileA()), { fileName: 'b.xlsx', vendors: SEED_VENDORS })
    const b = await analyzeSheet(readWorkbook(await makeFileB()), { fileName: 'c.xlsx', vendors: SEED_VENDORS })
    expect(a1.fingerprint).toBe(a2.fingerprint)
    expect(a1.fingerprint).not.toBe(b.fingerprint)
  })
})
