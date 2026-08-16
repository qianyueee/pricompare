import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { makeQuote } from '../fixtures/rows'
import {
  KK_HEADERS,
  KK_SHEET_NAME,
  SEED_VENDORS,
  buildCompare,
  buildKkWorkbook,
} from '@engine/index'
import type { CompareResult } from '@engine/types'

async function reload(buffer: ArrayBuffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  const ws = wb.getWorksheet(KK_SHEET_NAME)
  expect(ws).toBeDefined()
  return ws!
}

function headerValues(ws: ExcelJS.Worksheet): string[] {
  const vals = ws.getRow(1).values as (string | undefined)[]
  return vals.slice(1).map((v) => String(v ?? ''))
}

function buildSample(): CompareResult {
  return buildCompare(
    [
      {
        vendorId: 'hc',
        vendorDisplay: 'HC',
        rows: [
          makeQuote('P-1', { amount: 100, lead: '22', quoteNo: 'KT001', material: '6061' }),
          makeQuote('P-2', { qty: 5, pending: true, quoteNo: 'KT001' }),
        ],
      },
      {
        vendorId: 'skw',
        vendorDisplay: 'SKW',
        rows: [makeQuote('P-1', { amount: 90, lead: '3 weeks+cleaning', quoteNo: 'KV001' })],
      },
      {
        vendorId: 'newv',
        vendorDisplay: '新供应商',
        rows: [makeQuote('P-1', { amount: 95, lead: '10天', quoteNo: 'NV001' })],
      },
      {
        vendorId: 'usv',
        vendorDisplay: 'US Shop',
        rows: [makeQuote('P-1', { amount: 20, currency: 'USD', lead: '30 days', quoteNo: 'US001' })],
      },
    ],
    6.5,
  )
}

describe('KK 汇总导出', () => {
  it('槽位分配：已知供应商回传统列、未知占空槽改表头、USD 落 O 列', async () => {
    const out = await buildKkWorkbook(buildSample(), {
      batchName: '20260802 测试',
      usdRate: 6.5,
      registry: SEED_VENDORS,
      displayNames: { hc: 'HC', skw: 'SKW', newv: '新供应商', usv: 'US Shop' },
    })
    expect(out.slotByVendor['hc']).toBe(9) // J
    expect(out.slotByVendor['skw']).toBe(10) // K
    expect(out.slotByVendor['newv']).toBe(8) // I（Mao 缺席，最左空槽）
    expect(out.slotByVendor['usv']).toBe(14) // O
    expect(out.headers).toHaveLength(33)
    expect(out.headers[8]).toBe('新供应商')
    // 其余表头逐字节与 KK 模板一致（含 \n 与双空格）
    KK_HEADERS.forEach((h, i) => {
      if (i !== 8) expect(out.headers[i]).toBe(h)
    })
    expect(out.warnings).toHaveLength(0)
  })

  it('写出的工作簿：表头/价格/最低价填充色/TDB/H=最低价/P=H÷汇率/W 交期拼接', async () => {
    const out = await buildKkWorkbook(buildSample(), {
      batchName: '20260802 测试',
      usdRate: 6.5,
      registry: SEED_VENDORS,
      displayNames: { hc: 'HC', skw: 'SKW', newv: '新供应商', usv: 'US Shop' },
    })
    const ws = await reload(out.buffer)
    expect(headerValues(ws).slice(0, 33)).toEqual(out.headers)
    // P-1 行：I=新供应商95 J=HC100 K=SKW90(最低,绿) O=US20
    const r2 = ws.getRow(2)
    expect(r2.getCell(4).value).toBe('P-1')
    expect(r2.getCell(9).value).toBe(95)
    expect(r2.getCell(10).value).toBe(100)
    expect(r2.getCell(11).value).toBe(90)
    expect(r2.getCell(15).value).toBe(20)
    const minFill = r2.getCell(11).fill as ExcelJS.FillPattern
    expect(minFill.fgColor?.argb).toBe('FFC6EFCE')
    const notMinFill = r2.getCell(10).fill as ExcelJS.FillPattern | undefined
    expect(notMinFill?.fgColor?.argb).not.toBe('FFC6EFCE')
    // H = 最低人民币等值 90；P = 90/6.5
    expect(r2.getCell(8).value).toBe(90)
    expect(r2.getCell(16).value).toBeCloseTo(13.85)
    // V/W 按列序拼接（I 新供应商 → J HC → K SKW → O US）
    expect(r2.getCell(22).value).toBe('NV001/KT001/KV001/US001')
    // 纯数字交期在导出里也补单位（用户约定 "22days"）
    expect(r2.getCell(23).value).toBe('10天/22Days/3 weeks+cleaning/30 days')
    // B 列汇总名称
    expect(r2.getCell(2).value).toBe('20260802 测试')
    // P-2 行：HC TDB（琥珀色），H 也是 TDB
    const r3 = ws.getRow(3)
    expect(r3.getCell(4).value).toBe('P-2')
    expect(r3.getCell(10).value).toBe('TDB')
    const pendFill = r3.getCell(10).fill as ExcelJS.FillPattern
    expect(pendFill.fgColor?.argb).toBe('FFFFEB9C')
    expect(r3.getCell(8).value).toBe('TDB')
    expect(r3.getCell(16).value).toBeNull()
  })

  it('超出 I–N 槽位时在 N 后插入新列并告警', async () => {
    const vendors = ['mao', 'hc', 'skw', 'by', 'yj', 'jm'].map((id) => ({
      vendorId: id,
      vendorDisplay: id.toUpperCase(),
      rows: [makeQuote('P-1', { amount: 100 })],
    }))
    vendors.push(
      { vendorId: 'x1', vendorDisplay: '厂商七', rows: [makeQuote('P-1', { amount: 70 })] },
      { vendorId: 'x2', vendorDisplay: '厂商八', rows: [makeQuote('P-1', { amount: 60 })] },
    )
    const result = buildCompare(vendors, 6.5)
    const out = await buildKkWorkbook(result, {
      batchName: 'X',
      usdRate: 6.5,
      registry: SEED_VENDORS,
      displayNames: { x1: '厂商七', x2: '厂商八' },
    })
    expect(out.headers).toHaveLength(35)
    expect(out.headers[14]).toBe('厂商七')
    expect(out.headers[15]).toBe('厂商八')
    expect(out.headers[16]).toBe('US Vendor (US$)') // O 列后移
    expect(out.slotByVendor['x1']).toBe(14)
    expect(out.slotByVendor['x2']).toBe(15)
    expect(out.warnings.some((w) => w.includes('插入'))).toBe(true)
    const ws = await reload(out.buffer)
    expect(ws.getRow(2).getCell(16).value).toBe(60) // 厂商八最低
  })
})
