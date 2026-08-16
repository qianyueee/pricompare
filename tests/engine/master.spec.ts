import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { makeFileA, makeMasterFile, FIXTURE_PNS } from '../fixtures/buildFixtures'
import { makeQuote } from '../fixtures/rows'
import {
  KK_COL,
  KK_HEADERS,
  applyMerge,
  buildMasterWorkbook,
  guessBatchLabel,
  isMasterWorkbook,
  isPlaceholderRow,
  isRealQuoteNo,
  parseMasterWorkbook,
  planMerge,
  readWorkbook,
} from '@engine/index'
import type { MasterData } from '@engine/index'

async function loadMaster(): Promise<MasterData> {
  const pw = readWorkbook(await makeMasterFile())
  const master = parseMasterWorkbook(pw, 'KK汇总测试.xlsm')
  expect(master).not.toBeNull()
  return master!
}

describe('汇总表解析', () => {
  it('识别汇总工作簿、拆行、透传 NEGO、识别预编号空行', async () => {
    const master = await loadMaster()
    expect(master.sheetName).toBe('KK询价汇总')
    expect(master.rows).toHaveLength(5) // 2 数据行 + 3 预编号空行
    expect(master.rows[0]!.cells[KK_COL.pn]).toBe(FIXTURE_PNS[0])
    expect(master.rows[0]!.cells[9]).toBe(56.7)
    expect(isPlaceholderRow(master.rows[2]!)).toBe(true)
    expect(master.passthrough.map((s) => s.name)).toEqual(['NEGO'])
    expect(master.passthrough[0]!.grid[0]![1]).toBe('Basis For Negotiation')
    // 报价文件不会被误判为汇总
    expect(isMasterWorkbook(readWorkbook(await makeFileA()))).toBe(false)
  })
})

describe('合并规则', () => {
  it('真单号判定与批次猜测', () => {
    expect(isRealQuoteNo('KV202608151')).toBe(true)
    expect(isRealQuoteNo('KT20260711B')).toBe(true)
    expect(isRealQuoteNo('询价 20260814 Natalie A')).toBe(false)
    expect(guessBatchLabel([makeQuote('X', { quoteNo: '询价 20260814 Natalie A' })], 'x.xlsx')).toBe(
      '20260814 Natalie A',
    )
    expect(guessBatchLabel([makeQuote('X')], 'HCQuote_询价_20260814_Natalie_A.xlsx')).toBe(
      '20260814 Natalie A',
    )
    expect(guessBatchLabel([makeQuote('X', { quoteNo: 'KV202608151' })], 'KV202608153.xlsx')).toBe('')
  })

  it('SKW 报价：填充既有行（K 列、W 追加在后、V 真单号、H/U 取自带 Quote(EA) 的文件）', async () => {
    const master = await loadMaster()
    const quote = makeQuote(FIXTURE_PNS[0]!, {
      qty: 10,
      amount: 45,
      lead: '3 weeks+cleaning',
      quoteNo: 'KV202608151',
      quoteEa: '31',
      item: '1',
      material: '304',
    })
    const plan = planMerge(master, [quote], {
      batch: '20260814 Test',
      vendorSlot: 10,
      vendorId: 'skw',
      vendorDisplay: 'SKW',
    })
    expect(plan.fillCount).toBe(1)
    expect(plan.appendCount).toBe(0)
    const merged = applyMerge(master, plan)
    const row = merged.rows[0]!
    expect(row.cells[10]).toBe(45) // K
    expect(row.cells[KK_COL.leadTime]).toBe('22Days/3 weeks+cleaning') // K 在 J 之后 → 追加
    expect(row.cells[KK_COL.quoteNo]).toBe('KV202608151')
    expect(row.cells[KK_COL.quoteEach]).toBe(45) // H 只因带 quoteEa 才填
    expect(row.cells[KK_COL.quoteEa]).toBe(31)
    expect(row.cells[KK_COL.material]).toBe('304')
    // 原对象不被修改
    expect(master.rows[0]!.cells[10]).toBeNull()
  })

  it('HC 报价：J 列在前 → W 前插；无 Quote(EA) 不动 H/U；批次标签不进 V', async () => {
    const master = await loadMaster()
    // 先造一行只有 SKW 报过的行
    master.rows[0]!.cells[9] = null
    master.rows[0]!.cells[10] = 45
    master.rows[0]!.cells[KK_COL.leadTime] = '3 weeks+cleaning'
    const quote = makeQuote(FIXTURE_PNS[0]!, {
      qty: 10,
      amount: 56.7,
      lead: '22',
      quoteNo: '询价 20260814 Natalie A',
    })
    const plan = planMerge(master, [quote], {
      batch: '20260814 Natalie A',
      vendorSlot: 9,
      vendorId: 'hc',
      vendorDisplay: 'HC',
    })
    const merged = applyMerge(master, plan)
    const row = merged.rows[0]!
    expect(row.cells[9]).toBe(56.7)
    expect(row.cells[KK_COL.leadTime]).toBe('22Days/3 weeks+cleaning') // J 在前 → 前插
    expect(row.cells[KK_COL.quoteNo]).toBeNull() // 批次标签不算真单号
    expect(row.cells[KK_COL.quoteEach]).toBeNull() // 无 quoteEa 不填 H
  })

  it('找不到可填行 → 依次占用预编号空行（保留 A 序号），用完后续号新增', async () => {
    const master = await loadMaster()
    const quotes = [
      makeQuote('NEW-1', { qty: 3, amount: 100, item: '1', quoteNo: 'KV202608152', quoteEa: '64' }),
      makeQuote('NEW-2', { qty: 3, amount: 200, item: '2', quoteNo: 'KV202608152', quoteEa: '128' }),
      makeQuote('NEW-3', { qty: 3, amount: 300, item: '3', quoteNo: 'KV202608152', quoteEa: '192' }),
      makeQuote('NEW-4', { qty: 3, amount: 400, item: '4', quoteNo: 'KV202608152', quoteEa: '256' }),
    ]
    const plan = planMerge(master, quotes, {
      batch: '20260815 Batch',
      vendorSlot: 10,
      vendorId: 'skw',
      vendorDisplay: 'SKW',
    })
    expect(plan.fillCount).toBe(0)
    expect(plan.appendCount).toBe(4)
    const merged = applyMerge(master, plan)
    expect(merged.rows).toHaveLength(6) // 5 + 超出预编号的 1 行
    expect(merged.rows[2]!.cells[0]).toBe(3) // 预编号 A 保留
    expect(merged.rows[2]!.cells[KK_COL.pn]).toBe('NEW-1')
    expect(merged.rows[2]!.cells[KK_COL.name]).toBe('20260815 Batch')
    expect(merged.rows[5]!.cells[0]).toBe(6) // 新行续号
    expect(merged.rows[5]!.cells[KK_COL.pn]).toBe('NEW-4')
    // 同一 P/N 不同数量档各占一行、互不影响
    const tierPlan = planMerge(merged, [makeQuote('NEW-1', { qty: 9, amount: 80 })], {
      batch: 'X',
      vendorSlot: 10,
      vendorId: 'skw',
      vendorDisplay: 'SKW',
    })
    expect(tierPlan.appendCount).toBe(1)
  })
})

describe('汇总导出', () => {
  it('无原文件：从零重建（表头逐字节 + 数据 + NEGO 透传）', async () => {
    const master = await loadMaster()
    const out = await buildMasterWorkbook(master, null)
    expect(out.mode).toBe('fresh')
    expect(out.extension).toBe('xlsx')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(out.buffer)
    const ws = wb.getWorksheet('KK询价汇总')!
    KK_HEADERS.forEach((h, i) => expect(ws.getRow(1).getCell(i + 1).value).toBe(h))
    expect(ws.getCell('D2').value).toBe(FIXTURE_PNS[0])
    expect(ws.getCell('J2').value).toBe(56.7)
    expect(wb.getWorksheet('NEGO')!.getCell('B1').value).toBe('Basis For Negotiation')
  })

  it('有原文件：以原工作簿为底只改汇总数据（编辑与合并结果写回、NEGO 保留）', async () => {
    const original = await makeMasterFile()
    const master = parseMasterWorkbook(readWorkbook(original), 'm.xlsm')!
    master.rows[0]!.cells[9] = 999.5 // 模拟编辑 J2
    const out = await buildMasterWorkbook(master, original)
    expect(out.mode).toBe('patch')
    expect(out.extension).toBe('xlsx') // 固件由 exceljs 生成，标准内容类型
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(out.buffer)
    const ws = wb.getWorksheet('KK询价汇总')!
    expect(ws.getCell('J2').value).toBe(999.5)
    expect(ws.getCell('H3').value).toBe(90) // 未动的行保持
    expect(wb.getWorksheet('NEGO')!.getCell('A2').value).toBe('marker')
  })
})
