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
const WK = 13 // N 列

/**
 * 11-25 之前的真实汇总表：N 列表头还是 JM（I 列已是 ZTL）；汇总 sheet 是一张带斑马纹的 Excel 表格。数据虚构。
 */
async function makeJmHeaderMasterFile(): Promise<ArrayBuffer> {
  const headers = KK_HEADERS.map((h, i) => (i === WK ? 'JM' : h))
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('KK询价汇总')
  const rows: (string | number | null)[][] = []
  for (let i = 0; i < 2; i++) {
    const row: (string | number | null)[] = headers.map(() => null)
    row[0] = i + 1
    row[1] = '20261124 Eugene'
    row[3] = '1211491-000'
    row[6] = i === 0 ? 10 : 20
    row[ZTL] = 220 - i * 20
    row[WK] = i === 0 ? 699.47 : null
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

describe('N 列 JM 换成 WK（2026-11-25）', () => {
  it('表头还是 JM 的汇总表照样把 N 列读进 WK 列', async () => {
    const master = parseMasterWorkbook(readWorkbook(await makeJmHeaderMasterFile()), 'kk.xlsm')!
    expect(master.rows).toHaveLength(2)
    expect(master.rows[0]!.cells[KK_COL.pn]).toBe('1211491-000')
    expect(master.rows[0]!.cells[WK]).toBe(699.47)
    expect(master.rows[0]!.cells[ZTL]).toBe(220)
    expect(master.rows[1]!.cells[WK]).toBeNull()
  })

  it('以原表为底补丁导出：WK 价写进 N 列，N1 表头和表格列名改成 WK，其余表头不动', async () => {
    const original = await makeJmHeaderMasterFile()
    const master = parseMasterWorkbook(readWorkbook(original), 'kk.xlsm')!
    master.rows[1]!.cells[WK] = 636.19
    const out = await buildMasterWorkbook(master, original)
    expect(out.mode).toBe('patch')
    const ws = await sheetOf(out.buffer)
    expect(ws.getCell('N1').value).toBe('WK')
    expect(ws.getCell('M1').value).toBe('XH')
    expect(ws.getCell('I1').value).toBe('ZTL')
    expect(ws.getCell('N2').value).toBe(699.47)
    expect(ws.getCell('N3').value).toBe(636.19)
    const names = tableColumnNames(out.buffer)
    expect(names).toHaveLength(1)
    expect(names[0]![WK]).toBe('WK')
    expect(names[0]).not.toContain('JM')
    // 再读回来：WK 列对得上
    const again = parseMasterWorkbook(readWorkbook(out.buffer), 'kk.xlsm')!
    expect(again.rows[1]!.cells[WK]).toBe(636.19)
  })

  it('数据一格没改也把表头改成 WK（仍是补丁导出）', async () => {
    const original = await makeJmHeaderMasterFile()
    const master = parseMasterWorkbook(readWorkbook(original), 'kk.xlsm')!
    const out = await buildMasterWorkbook(master, original)
    expect(out.mode).toBe('patch')
    expect((await sheetOf(out.buffer)).getCell('N1').value).toBe('WK')
    expect(tableColumnNames(out.buffer)[0]![WK]).toBe('WK')
  })

  it('只导出选中的行（汇总表格式）：表头和表格列名也是 WK', async () => {
    const original = await makeJmHeaderMasterFile()
    const master = parseMasterWorkbook(readWorkbook(original), 'kk.xlsm')!
    const out = await buildMasterSubsetWorkbook(master, [0], original)
    expect(out.mode).toBe('template')
    const ws = await sheetOf(out.buffer)
    expect(ws.getCell('N1').value).toBe('WK')
    expect(ws.getCell('N2').value).toBe(699.47)
    expect(tableColumnNames(out.buffer)[0]![WK]).toBe('WK')
  })

  it('比价页把 N 列的价列成 WK', () => {
    const cells = Array.from({ length: KK_HEADERS.length }, () => null as string | number | null)
    cells[KK_COL.pn] = '1211491-000'
    cells[KK_COL.qty] = 10
    cells[ZTL] = 220
    cells[WK] = 699.47
    const summary = buildNegoSummary([
      buildNegoLine({ rows: [{ cells }], sheetName: 'KK询价汇总', passthrough: [], sourceFileName: null, importedAt: null }, 0),
    ])
    expect(summary.vendors.map((v) => v.label)).toEqual(['ZTL', 'WK'])
  })
})

describe('供应商注册表：JM 换成 WK', () => {
  it('已存的注册表里的 JM 原位改成 WK（N 列，带韦克别名），其余不动；可重复执行', () => {
    const saved: Vendor[] = [
      ...SEED_VENDORS.filter((v) => v.id !== 'wk' && v.id !== 'yj'),
      { id: 'jm', display: 'JM', kkSlot: 'N', aliases: ['jm'] },
      SEED_VENDORS.find((v) => v.id === 'yj')!,
      { id: 'custom', display: '自定义', aliases: ['zz'] },
    ]
    const { registry, migrated } = migrateVendorRegistry(saved)
    expect(migrated).toBe(true)
    expect(registry.map((v) => v.id)).toEqual(saved.map((v) => (v.id === 'jm' ? 'wk' : v.id)))
    registry.forEach((v, i) => {
      if (v.id !== 'wk') expect(v).toBe(saved[i])
    })
    expect(registry.find((v) => v.id === 'wk')).toEqual({
      id: 'wk',
      display: 'WK',
      kkSlot: 'N',
      aliases: ['wk', '韦克', 'wayken', 'waykenrm'],
    })
    expect(migrateVendorRegistry(registry)).toEqual({ registry, migrated: false })
  })

  it('11-06 之前的注册表（还有 BY、Mao、JM）：一次迁成 XH、ZTL、WK，落列不变', () => {
    const old: Record<string, Vendor> = {
      ztl: { id: 'mao', display: 'Mao', kkSlot: 'I', aliases: ['mao'] },
      xh: { id: 'by', display: 'BY', kkSlot: 'M', aliases: ['by'] },
      wk: { id: 'jm', display: 'JM', kkSlot: 'N', aliases: ['jm'] },
    }
    const saved: Vendor[] = SEED_VENDORS.map((v) => old[v.id] ?? v)
    const { registry, migrated } = migrateVendorRegistry(saved)
    expect(migrated).toBe(true)
    expect(registry.map((v) => [v.id, v.kkSlot])).toEqual(SEED_VENDORS.map((v) => [v.id, v.kkSlot]))
  })

  it('韦克的报价文件认成 WK：文件名带「韦克」或 WayKen；零件名里的 wk 字母不误判', () => {
    const base = { quoteNos: [], nameValues: [], priceHeader: '' }
    expect(guessVendor(SEED_VENDORS, { ...base, fileName: '韦克-26U11357.xlsx' }).vendorId).toBe('wk')
    expect(guessVendor(SEED_VENDORS, { ...base, fileName: 'WayKen Quotation 26U11341V4.xlsx' }).vendorId).toBe('wk')
    expect(guessVendor(SEED_VENDORS, { ...base, fileName: 'WK报价20261125.xlsx' }).vendorId).toBe('wk')
    expect(guessVendor(SEED_VENDORS, { ...base, fileName: 'Hawkeye bracket.xlsx' }).vendorId).not.toBe('wk')
  })
})
