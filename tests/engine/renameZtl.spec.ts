import ExcelJS from 'exceljs'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  KK_COL,
  KK_HEADERS,
  SEED_VENDORS,
  buildMasterSubsetWorkbook,
  buildMasterWorkbook,
  buildNegoLine,
  buildNegoSummary,
  guessVendor,
  migrateVendorRegistry,
  parseMasterWorkbook,
  readWorkbook,
} from '@engine/index'
import type { Vendor } from '@engine/index'

const dec = new TextDecoder()
const ZTL = 8 // I 列
const XH = 12 // M 列

/**
 * 11-17 之前的真实汇总表：I 列表头还是 Mao、M 列表头还是 BY；汇总 sheet 是一张带斑马纹的 Excel 表格。数据虚构。
 */
async function makeMaoHeaderMasterFile(): Promise<ArrayBuffer> {
  const headers = KK_HEADERS.map((h, i) => (i === ZTL ? 'Mao' : i === XH ? 'BY' : h))
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('KK询价汇总')
  const rows: (string | number | null)[][] = []
  for (let i = 0; i < 2; i++) {
    const row: (string | number | null)[] = headers.map(() => null)
    row[0] = i + 1
    row[1] = '20261111 Orly'
    row[3] = '1265265-000'
    row[6] = i === 0 ? 1 : 3
    row[9] = 2034 - i * 678 // J HC
    row[10] = 1580 - i * 428 // K SKW
    rows.push(row)
  }
  ws.addTable({
    name: 'KKTable',
    ref: 'A1',
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: headers.map((name) => ({ name })),
    rows,
  })
  wb.addWorksheet('NEGO').getCell('A1').value = 'Basis For Negotiation'
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer
}

async function sheetOf(buffer: ArrayBuffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  return wb.getWorksheet('KK询价汇总')!
}

/** 导出文件里所有表格定义的列名 */
function tableColumnNames(buffer: ArrayBuffer): string[][] {
  const files = unzipSync(new Uint8Array(buffer))
  return Object.keys(files)
    .filter((p) => /^xl\/tables\/[^/]+\.xml$/.test(p))
    .map((p) => [...dec.decode(files[p]!).matchAll(/<tableColumn\b[^>]*\sname="([^"]*)"/g)].map((m) => m[1]!))
}

describe('I 列 Mao 换成 ZTL（2026-11-17）', () => {
  it('表头还是 Mao 的汇总表照样把 I 列读进 ZTL 列', async () => {
    const master = parseMasterWorkbook(readWorkbook(await makeMaoHeaderMasterFile()), 'kk.xlsm')!
    expect(master.rows).toHaveLength(2)
    expect(master.rows[0]!.cells[KK_COL.pn]).toBe('1265265-000')
    expect(master.rows[0]!.cells[9]).toBe(2034)
    expect(master.rows[0]!.cells[ZTL]).toBeNull()
  })

  it('以原表为底补丁导出：ZTL 价写进 I 列，I1、M1 表头和表格列名改成 ZTL、XH，其余表头不动', async () => {
    const original = await makeMaoHeaderMasterFile()
    const master = parseMasterWorkbook(readWorkbook(original), 'kk.xlsm')!
    master.rows[0]!.cells[ZTL] = 2700
    master.rows[1]!.cells[ZTL] = 1900
    const out = await buildMasterWorkbook(master, original)
    expect(out.mode).toBe('patch')
    const ws = await sheetOf(out.buffer)
    expect(ws.getCell('I1').value).toBe('ZTL')
    expect(ws.getCell('M1').value).toBe('XH')
    expect(ws.getCell('J1').value).toBe('HC')
    expect(ws.getCell('I2').value).toBe(2700)
    expect(ws.getCell('I3').value).toBe(1900)
    expect(ws.getCell('J2').value).toBe(2034)
    const names = tableColumnNames(out.buffer)
    expect(names).toHaveLength(1)
    expect(names[0]![ZTL]).toBe('ZTL')
    expect(names[0]![XH]).toBe('XH')
    expect(names[0]).not.toContain('Mao')
    // 再读回来：ZTL 列对得上
    const again = parseMasterWorkbook(readWorkbook(out.buffer), 'kk.xlsm')!
    expect(again.rows[0]!.cells[ZTL]).toBe(2700)
  })

  it('只导出选中的行（汇总表格式）：表头和表格列名也是 ZTL', async () => {
    const original = await makeMaoHeaderMasterFile()
    const master = parseMasterWorkbook(readWorkbook(original), 'kk.xlsm')!
    master.rows[1]!.cells[ZTL] = 1900
    const out = await buildMasterSubsetWorkbook(master, [1], original)
    expect(out.mode).toBe('template')
    const ws = await sheetOf(out.buffer)
    expect(ws.getCell('I1').value).toBe('ZTL')
    expect(ws.getCell('I2').value).toBe(1900)
    expect(tableColumnNames(out.buffer)[0]![ZTL]).toBe('ZTL')
  })

  it('比价页把 I 列的价列成 ZTL', () => {
    const cells = Array.from({ length: KK_HEADERS.length }, () => null as string | number | null)
    cells[KK_COL.pn] = '1265265-000'
    cells[KK_COL.qty] = 1
    cells[ZTL] = 2700
    cells[9] = 2034 // HC
    cells[10] = 1580 // SKW
    const summary = buildNegoSummary([
      buildNegoLine({ rows: [{ cells }], sheetName: 'KK询价汇总', passthrough: [], sourceFileName: null, importedAt: null }, 0),
    ])
    expect(summary.vendors.map((v) => v.label)).toEqual(['ZTL', 'HC', 'SKW'])
  })
})

describe('供应商注册表：Mao 换成 ZTL', () => {
  it('已存的注册表里的 Mao 原位改成 ZTL（I 列，带正泰隆别名），其余不动；可重复执行', () => {
    const saved: Vendor[] = [
      { id: 'mao', display: 'Mao', kkSlot: 'I', aliases: ['mao'] },
      ...SEED_VENDORS.filter((v) => v.id !== 'ztl'),
      { id: 'custom', display: '自定义', aliases: ['zz'] },
    ]
    const { registry, migrated } = migrateVendorRegistry(saved)
    expect(migrated).toBe(true)
    expect(registry.map((v) => v.id)).toEqual(saved.map((v) => (v.id === 'mao' ? 'ztl' : v.id)))
    registry.forEach((v, i) => {
      if (v.id !== 'ztl') expect(v).toBe(saved[i])
    })
    expect(registry.find((v) => v.id === 'ztl')).toEqual({
      id: 'ztl',
      display: 'ZTL',
      kkSlot: 'I',
      aliases: ['ztl', '正泰隆', 'zintilon'],
    })
    expect(migrateVendorRegistry(registry)).toEqual({ registry, migrated: false })
  })

  it('11-06 之前的注册表（还有 BY 和 Mao）：一次迁成 XH 和 ZTL，落列不变', () => {
    const saved: Vendor[] = SEED_VENDORS.map((v) =>
      v.id === 'ztl'
        ? { id: 'mao', display: 'Mao', kkSlot: 'I', aliases: ['mao'] }
        : v.id === 'xh'
          ? { id: 'by', display: 'BY', kkSlot: 'M', aliases: ['by'] }
          : v,
    )
    const { registry, migrated } = migrateVendorRegistry(saved)
    expect(migrated).toBe(true)
    expect(registry.map((v) => [v.id, v.kkSlot])).toEqual(SEED_VENDORS.map((v) => [v.id, v.kkSlot]))
  })

  it('正泰隆的报价文件认成 ZTL：文件名带「正泰隆」（同名里的 Kavis 不会抢成 HC）', () => {
    const base = { quoteNos: [], nameValues: [], priceHeader: '' }
    expect(guessVendor(SEED_VENDORS, { ...base, fileName: '正泰隆_Kavis Tech_报价单.xlsx' }).vendorId).toBe('ztl')
    expect(guessVendor(SEED_VENDORS, { ...base, fileName: 'ZTL报价20261117.xlsx' }).vendorId).toBe('ztl')
    expect(guessVendor(SEED_VENDORS, { ...base, fileName: 'HC_0717.xlsx' }).vendorId).toBe('hc')
  })
})
