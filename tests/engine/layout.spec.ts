import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  KK_COL,
  KK_COL_COUNT,
  KK_HEADERS,
  KK_LEGACY_HEADERS,
  SEED_VENDORS,
  buildMasterWorkbook,
  buildNegoLine,
  buildNegoSummary,
  guessVendor,
  migrateMasterLayout,
  migrateVendorRegistry,
  parseMasterWorkbook,
  readWorkbook,
} from '@engine/index'
import type { MasterData, Vendor } from '@engine/index'

/** 10-07 之前的 33 列旧布局：L BY、M YJ、N JM、AG Base ID */
async function makeLegacyMasterFile(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('KK询价汇总')
  ws.getRow(1).values = [...KK_LEGACY_HEADERS]
  const r2 = ws.getRow(2)
  r2.getCell(1).value = 1
  r2.getCell(2).value = '20260901 Old'
  r2.getCell(4).value = '0100001-001'
  r2.getCell(7).value = 10
  r2.getCell(10).value = 56.7 // J HC
  r2.getCell(12).value = 11 // L BY
  r2.getCell(13).value = 22 // M YJ
  r2.getCell(14).value = 33 // N JM
  r2.getCell(30).value = 'note' // AD Comment
  r2.getCell(33).value = 'B-1' // AG Base ID
  wb.addWorksheet('NEGO').getCell('A1').value = 'marker'
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer
}

async function sheetOf(buffer: ArrayBuffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  return wb.getWorksheet('KK询价汇总')!
}

describe('10-07 新布局（34 列，L 列 CL，YJ 在 AG）', () => {
  it('表头 34 列，供应商槽位 I–N 为 Mao/HC/SKW/CL/BY/JM，YJ 在 AG', () => {
    expect(KK_HEADERS).toHaveLength(34)
    expect(KK_COL_COUNT).toBe(34)
    expect(KK_HEADERS.slice(8, 14)).toEqual(['Mao', 'HC', 'SKW', 'CL', 'BY', 'JM'])
    expect(KK_HEADERS[KK_COL.yj]).toBe('YJ')
    expect(KK_HEADERS[KK_COL.basePn]).toBe('Base P/N')
    expect(KK_HEADERS[KK_COL.baseId]).toBe('Base ID')
    expect(KK_LEGACY_HEADERS).toHaveLength(33)
  })

  it('旧布局文件按表头对位导入：BY→M、YJ→AG、JM 留 N、Base ID→AH，CL 留空', async () => {
    const master = parseMasterWorkbook(readWorkbook(await makeLegacyMasterFile()), 'old.xlsx')!
    const cells = master.rows[0]!.cells
    expect(cells).toHaveLength(KK_COL_COUNT)
    expect(cells[9]).toBe(56.7)
    expect(cells[11]).toBeNull() // CL
    expect(cells[12]).toBe(11) // BY
    expect(cells[13]).toBe(33) // JM
    expect(cells[KK_COL.yj]).toBe(22)
    expect(cells[KK_COL.comment]).toBe('note')
    expect(cells[KK_COL.baseId]).toBe('B-1')
  })

  it('中间布局（插了 CL 但 YJ 还在 N）也按表头读对', async () => {
    const headers = [...KK_HEADERS.slice(0, 12), 'BY', 'YJ', 'JM', ...KK_HEADERS.slice(14, 32), 'Base ID']
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('KK询价汇总')
    ws.getRow(1).values = headers
    const r2 = ws.getRow(2)
    r2.getCell(1).value = 1
    r2.getCell(4).value = 'P-1'
    r2.getCell(12).value = 5 // L CL
    r2.getCell(14).value = 7 // N YJ
    r2.getCell(15).value = 9 // O JM
    const master = parseMasterWorkbook(readWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer), 'mid.xlsx')!
    const cells = master.rows[0]!.cells
    expect(cells[11]).toBe(5)
    expect(cells[13]).toBe(9)
    expect(cells[KK_COL.yj]).toBe(7)
  })

  it('旧版本存下的 33 格总表迁移到新布局，新布局的行不动，可重复执行', () => {
    const legacy = Array.from({ length: 33 }, () => null as string | number | null)
    legacy[0] = 1
    legacy[3] = 'P-1'
    legacy[11] = 11 // BY
    legacy[12] = 22 // YJ
    legacy[13] = 33 // JM
    legacy[31] = 'BASE'
    legacy[32] = 'B-1'
    const current = Array.from({ length: KK_COL_COUNT }, () => null as string | number | null)
    current[0] = 2
    current[11] = 99 // CL
    const master: MasterData = {
      rows: [{ cells: legacy }, { cells: current }],
      sheetName: 'KK询价汇总',
      passthrough: [],
      sourceFileName: null,
      importedAt: null,
    }
    const { master: next, migratedRows } = migrateMasterLayout(master)
    expect(migratedRows).toBe(1)
    const c = next.rows[0]!.cells
    expect(c).toHaveLength(KK_COL_COUNT)
    expect([c[11], c[12], c[13], c[KK_COL.yj]]).toEqual([null, 11, 33, 22])
    expect(c[KK_COL.basePn]).toBe('BASE')
    expect(c[KK_COL.baseId]).toBe('B-1')
    expect(next.rows[1]).toBe(master.rows[1])
    expect(migrateMasterLayout(next).migratedRows).toBe(0)
  })

  it('以旧布局原文件为底补丁导出：改 BY 写回原 L 列；填了 CL（原表没有）→ 整本重写并换新表头', async () => {
    const original = await makeLegacyMasterFile()
    const master = parseMasterWorkbook(readWorkbook(original), 'old.xlsx')!
    master.rows[0]!.cells[12] = 12.5 // BY
    const patched = await buildMasterWorkbook(master, original)
    expect(patched.mode).toBe('patch')
    const ws = await sheetOf(patched.buffer)
    expect(ws.getCell('L1').value).toBe('BY') // 原表头不动
    expect(ws.getCell('L2').value).toBe(12.5)
    expect(ws.getCell('M2').value).toBe(22) // YJ 原位
    expect(ws.getCell('N2').value).toBe(33)

    master.rows[0]!.cells[11] = 88 // CL
    const rewritten = await buildMasterWorkbook(master, original)
    expect(rewritten.mode).toBe('rewrite')
    const ws2 = await sheetOf(rewritten.buffer)
    KK_HEADERS.forEach((h, i) => expect(ws2.getRow(1).getCell(i + 1).value).toBe(h))
    expect(ws2.getCell('L2').value).toBe(88)
    expect(ws2.getCell('M2').value).toBe(12.5)
    expect(ws2.getCell('AG2').value).toBe(22)
    expect(ws2.getCell('AH2').value).toBe('B-1')
  })
})

describe('供应商注册表', () => {
  it('旧注册表迁移：落列跟着原表头走（L→M、M→AG），补上 CL；已迁移的原样返回', () => {
    const old: Vendor[] = [
      { id: 'hc', display: 'HC', kkSlot: 'J', aliases: ['hc'] },
      { id: 'by', display: 'BY', kkSlot: 'L', aliases: ['by'] },
      { id: 'yj', display: 'YJ', kkSlot: 'M', aliases: ['yj'] },
      { id: 'jm', display: 'JM', kkSlot: 'N', aliases: ['jm'] },
      { id: 'custom', display: '自定义', aliases: ['zz'] },
    ]
    const { registry, migrated } = migrateVendorRegistry(old)
    expect(migrated).toBe(true)
    const slot = (id: string): string | undefined => registry.find((v) => v.id === id)?.kkSlot
    expect([slot('hc'), slot('by'), slot('yj'), slot('jm'), slot('cl')]).toEqual(['J', 'M', 'AG', 'N', 'L'])
    expect(slot('custom')).toBeUndefined()
    expect(migrateVendorRegistry(registry)).toEqual({ registry, migrated: false })
    expect(migrateVendorRegistry(SEED_VENDORS).migrated).toBe(false)
  })

  it('两个字母的别名不误伤零件名：Clamp 不是 CL；文件名带宸立才是', () => {
    const base = { quoteNos: [], nameValues: [], priceHeader: '' }
    expect(guessVendor(SEED_VENDORS, { ...base, fileName: 'Clamp_cleaning.xlsx' }).vendorId).toBeNull()
    expect(guessVendor(SEED_VENDORS, { ...base, fileName: '宸立报价 20261012.xlsx' }).vendorId).toBe('cl')
    expect(guessVendor(SEED_VENDORS, { ...base, fileName: 'HC_0717.xlsx' }).vendorId).toBe('hc')
  })
})

describe('比价含 CL 和 AG 列的 YJ', () => {
  it('NEGO 列出 CL 与 YJ 的单价', () => {
    const cells = Array.from({ length: KK_COL_COUNT }, () => null as string | number | null)
    cells[3] = 'P-1'
    cells[6] = 2
    cells[9] = 100 // HC
    cells[11] = 80 // CL
    cells[KK_COL.yj] = 90
    const master: MasterData = {
      rows: [{ cells }],
      sheetName: 'KK询价汇总',
      passthrough: [],
      sourceFileName: null,
      importedAt: null,
    }
    const summary = buildNegoSummary([buildNegoLine(master, 0)])
    expect(summary.vendors.map((v) => v.label)).toEqual(['HC', 'CL', 'YJ'])
  })
})
