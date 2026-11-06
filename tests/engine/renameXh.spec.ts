import ExcelJS from 'exceljs'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  KK_COL,
  KK_HEADERS,
  buildMasterSubsetWorkbook,
  buildMasterWorkbook,
  buildNegoLine,
  buildNegoSummary,
  parseMasterWorkbook,
  readWorkbook,
} from '@engine/index'

const dec = new TextDecoder()
const XH = 12 // M 列

/**
 * 11-06 之前的真实汇总表：34 列新布局，但 M 列表头还是 BY；汇总 sheet 是一张带斑马纹的 Excel 表格。数据虚构。
 */
async function makeByHeaderMasterFile(): Promise<ArrayBuffer> {
  const headers = KK_HEADERS.map((h, i) => (i === XH ? 'BY' : h))
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('KK询价汇总')
  const rows: (string | number | null)[][] = []
  for (let i = 0; i < 3; i++) {
    const row: (string | number | null)[] = headers.map(() => null)
    row[0] = i + 1
    row[1] = '20261104 Arvind'
    row[3] = '1322565-000'
    row[6] = i + 1
    row[9] = 2000 - i * 100 // J HC
    row[10] = 1600 - i * 100 // K SKW
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

describe('M 列 BY 换成 XH（2026-11-06）', () => {
  it('表头还是 BY 的汇总表照样把 M 列读进 XH 列', async () => {
    const master = parseMasterWorkbook(readWorkbook(await makeByHeaderMasterFile()), 'kk.xlsm')!
    expect(master.rows).toHaveLength(3)
    expect(master.rows[0]!.cells[KK_COL.pn]).toBe('1322565-000')
    expect(master.rows[0]!.cells[9]).toBe(2000)
    expect(master.rows[0]!.cells[XH]).toBeNull()
  })

  it('既有 XH 又有 BY 两个表头时认 XH（Zane 自己的 XH 报价表：XH 在 N、BY 挪到 AI）', async () => {
    const headers: string[] = [...KK_HEADERS.slice(0, 12), 'JM', 'XH', ...KK_HEADERS.slice(14), 'BY']
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('KK询价汇总')
    ws.getRow(1).values = headers
    ws.getRow(2).values = headers.map((h) => (h === 'P/N' ? 'P-1' : h === 'XH' ? 1469 : h === 'JM' ? 300 : h === 'BY' ? 7 : null))
    const master = parseMasterWorkbook(readWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer), 'xh.xlsx')!
    const cells = master.rows[0]!.cells
    expect(cells[XH]).toBe(1469)
    expect(cells[13]).toBe(300) // JM
  })

  it('以原表为底补丁导出：XH 价写进 M 列，M1 表头和表格列名改成 XH，其余表头不动；Excel 能正常打开', async () => {
    const original = await makeByHeaderMasterFile()
    const master = parseMasterWorkbook(readWorkbook(original), 'kk.xlsm')!
    master.rows[0]!.cells[XH] = 1130
    const out = await buildMasterWorkbook(master, original)
    expect(out.mode).toBe('patch')
    const ws = await sheetOf(out.buffer)
    expect(ws.getCell('M1').value).toBe('XH')
    expect(ws.getCell('L1').value).toBe('CL')
    expect(ws.getCell('N1').value).toBe('JM')
    expect(ws.getCell('M2').value).toBe(1130)
    expect(ws.getCell('J2').value).toBe(2000)
    const names = tableColumnNames(out.buffer)
    expect(names).toHaveLength(1)
    expect(names[0]![XH]).toBe('XH')
    expect(names[0]).not.toContain('BY')
    // 再读回来：XH 列对得上
    const again = parseMasterWorkbook(readWorkbook(out.buffer), 'kk.xlsm')!
    expect(again.rows[0]!.cells[XH]).toBe(1130)
  })

  it('数据一格没改也把表头改成 XH（仍是补丁导出）', async () => {
    const original = await makeByHeaderMasterFile()
    const master = parseMasterWorkbook(readWorkbook(original), 'kk.xlsm')!
    const out = await buildMasterWorkbook(master, original)
    expect(out.mode).toBe('patch')
    expect((await sheetOf(out.buffer)).getCell('M1').value).toBe('XH')
    expect(tableColumnNames(out.buffer)[0]![XH]).toBe('XH')
  })

  it('只导出选中的行（汇总表格式）：表头和表格列名也是 XH', async () => {
    const original = await makeByHeaderMasterFile()
    const master = parseMasterWorkbook(readWorkbook(original), 'kk.xlsm')!
    master.rows[1]!.cells[XH] = 734.5
    const out = await buildMasterSubsetWorkbook(master, [1], original)
    expect(out.mode).toBe('template')
    const ws = await sheetOf(out.buffer)
    expect(ws.getCell('M1').value).toBe('XH')
    expect(ws.getCell('K1').value).toBe('SKW')
    expect(ws.getCell('M2').value).toBe(734.5)
    expect(tableColumnNames(out.buffer)[0]![XH]).toBe('XH')
  })

  it('比价页把 M 列的价列成 XH', () => {
    const cells = Array.from({ length: KK_HEADERS.length }, () => null as string | number | null)
    cells[KK_COL.pn] = '1322565-000'
    cells[KK_COL.qty] = 1
    cells[9] = 2034 // HC
    cells[10] = 1600 // SKW
    cells[XH] = 1130
    const summary = buildNegoSummary([
      buildNegoLine({ rows: [{ cells }], sheetName: 'KK询价汇总', passthrough: [], sourceFileName: null, importedAt: null }, 0),
    ])
    expect(summary.vendors.map((v) => v.label)).toEqual(['HC', 'SKW', 'XH'])
  })
})
