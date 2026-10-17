import ExcelJS from 'exceljs'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { makeMasterFile, FIXTURE_PNS } from '../fixtures/buildFixtures'
import {
  KK_COL,
  KK_HEADERS,
  KK_LEGACY_HEADERS,
  buildMasterSubsetWorkbook,
  parseMasterWorkbook,
  readWorkbook,
} from '@engine/index'
import type { MasterData } from '@engine/index'

const dec = new TextDecoder()

/**
 * 仿真实 KK 汇总表的结构：汇总 sheet 是一张带斑马纹的 Excel 表格，O–S 列隐藏，
 * 冻结首行但视图停在很靠下的位置，有批注；另带 NEGO 和历史报价两张 sheet。数据均为虚构。
 */
async function makeStyledMasterFile(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('KK询价汇总', {
    views: [{ state: 'frozen', ySplit: 1, topLeftCell: 'A40', activeCell: 'C45' }],
  })
  const data: (string | number | null)[][] = []
  for (let i = 0; i < 6; i++) {
    const row: (string | number | null)[] = KK_HEADERS.map(() => null)
    row[0] = i + 1
    row[1] = i < 3 ? '20261001 Alpha' : '20261005 Beta'
    row[3] = `09${String(i).padStart(5, '0')}-000`
    row[4] = 'AA'
    row[5] = `TEST PART ${i}`
    row[6] = (i % 3) + 1
    row[9] = 100 + i // J HC
    row[10] = 90 + i // K SKW
    row[14] = 12.5 // O US Vendor（隐藏列）
    row[21] = `KV2026100${i}`
    data.push(row)
  }
  ws.addTable({
    name: 'KKTable',
    ref: 'A1',
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: KK_HEADERS.map((name) => ({ name })),
    rows: data,
  })
  for (let c = 15; c <= 19; c++) ws.getColumn(c).hidden = true // O–S
  ws.getColumn(4).width = 24
  ws.getCell('J3').font = { bold: true, color: { argb: 'FFFF0000' } } // 第 2 条数据的 HC 价标红加粗
  ws.getCell('D4').note = '这条批注挂在原表 D4 上'
  wb.addWorksheet('NEGO').getCell('A1').value = 'Basis For Negotiation'
  wb.addWorksheet('HC报价Prior').getCell('A1').value = 'old quotes'
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer
}

function parse(buffer: ArrayBuffer): MasterData {
  const m = parseMasterWorkbook(readWorkbook(buffer), 'x.xlsx')
  expect(m).not.toBeNull()
  return m!
}

describe('只导出选中的行（汇总表格式）', () => {
  it('以原表为模板：只有汇总 sheet、只有这几行，按给定顺序，值取当前总表', async () => {
    const original = await makeStyledMasterFile()
    const master = parse(original)
    expect(master.rows).toHaveLength(6)
    master.rows[4]!.cells[KK_COL.leadTime] = '15Days' // 导入后又改过的格子
    const out = await buildMasterSubsetWorkbook(master, [4, 1, 4, 99], original)
    expect(out.mode).toBe('template')
    expect(out.extension).toBe('xlsx')
    expect(out.rowCount).toBe(2) // 重复的 4 和越界的 99 不算

    const re = parse(out.buffer)
    expect(re.sheetName).toBe('KK询价汇总')
    expect(re.passthrough).toEqual([]) // NEGO / 历史报价不带
    expect(re.rows.map((r) => r.cells)).toEqual([master.rows[4]!.cells, master.rows[1]!.cells])
    expect(re.rows[0]!.cells[0]).toBe(5) // A 列保留总表里的序号，方便对照
    expect(re.rows[0]!.cells[KK_COL.leadTime]).toBe('15Days')
  })

  it('表头、列宽、隐藏列、样式、表格斑马纹沿用原表；视图回到顶部；批注不带', async () => {
    const original = await makeStyledMasterFile()
    const master = parse(original)
    const out = await buildMasterSubsetWorkbook(master, [1, 2], original)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(out.buffer)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['KK询价汇总'])
    const ws = wb.getWorksheet('KK询价汇总')!
    KK_HEADERS.forEach((h, i) => expect(ws.getRow(1).getCell(i + 1).value).toBe(h))
    for (let c = 15; c <= 19; c++) expect(ws.getColumn(c).hidden).toBe(true)
    expect(ws.getColumn(4).width).toBe(24)
    expect(ws.getCell('J2').font?.bold).toBe(true) // 原表第 3 行（第 2 条数据）的样式跟着行走
    expect(ws.getCell('J2').value).toBe(101)
    expect(ws.getCell('J3').font?.bold).toBeFalsy()
    expect(ws.getCell('O2').value).toBe(12.5) // 隐藏列的数据和整表导出一样保留

    const files = unzipSync(new Uint8Array(out.buffer))
    const table = dec.decode(files['xl/tables/table1.xml']!)
    expect(table).toMatch(/ref="A1:AH3"/)
    expect(table).toContain('<autoFilter ref="A1:AH3"/>')
    expect(table).toContain('TableStyleMedium2')
    const sheet = dec.decode(files['xl/worksheets/sheet1.xml']!)
    expect(sheet).toMatch(/<pane\b[^>]*topLeftCell="A2"/)
    expect(sheet).not.toContain('<selection')
    expect(sheet).not.toContain('legacyDrawing')
    expect(sheet).toContain('<dimension ref="A1:AH3"/>')
    expect(Object.keys(files).some((f) => /comments|vml|drawing/i.test(f))).toBe(false)
    const ct = dec.decode(files['[Content_Types].xml']!)
    expect(ct).toContain('spreadsheetml.sheet.main+xml') // 不带宏，.xlsx
  })

  it('没有表格的原表（旧固件）也走模板；NEGO 不带', async () => {
    const original = await makeMasterFile()
    const master = parse(original)
    const out = await buildMasterSubsetWorkbook(master, [1], original)
    expect(out.mode).toBe('template')
    const re = parse(out.buffer)
    expect(re.rows).toHaveLength(1)
    expect(re.rows[0]!.cells[KK_COL.pn]).toBe('0900001-000')
    expect(re.passthrough).toEqual([])
    expect(FIXTURE_PNS[0]).not.toBe(re.rows[0]!.cells[KK_COL.pn])
  })

  it('没有原文件或原表是旧布局：从零重建，同样只有这几行', async () => {
    const master = parse(await makeStyledMasterFile())
    const fresh = await buildMasterSubsetWorkbook(master, [3, 0], null)
    expect(fresh.mode).toBe('fresh')
    const re = parse(fresh.buffer)
    expect(re.rows.map((r) => r.cells[KK_COL.pn])).toEqual([
      master.rows[3]!.cells[KK_COL.pn],
      master.rows[0]!.cells[KK_COL.pn],
    ])
    expect(re.passthrough).toEqual([])

    const legacy = new ExcelJS.Workbook()
    const lws = legacy.addWorksheet('KK询价汇总')
    lws.getRow(1).values = [...KK_LEGACY_HEADERS]
    lws.getRow(2).values = [1, '20260901 Old', null, '0100001-001', 'AA', 'X', 10]
    const legacyBuf = (await legacy.xlsx.writeBuffer()) as ArrayBuffer
    const lm = parse(legacyBuf)
    const out = await buildMasterSubsetWorkbook(lm, [0], legacyBuf)
    expect(out.mode).toBe('fresh') // 原表没有 CL 列，表头对不上
    expect(parse(out.buffer).rows[0]!.cells[KK_COL.pn]).toBe('0100001-001')
  })

  it('一行都没有时报错', async () => {
    const master = parse(await makeMasterFile())
    await expect(buildMasterSubsetWorkbook(master, [42], null)).rejects.toThrow('没有可导出的行')
  })
})
