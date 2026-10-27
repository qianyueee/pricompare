import ExcelJS from 'exceljs'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  KK_COL,
  KK_HEADERS,
  buildMasterSubsetWorkbook,
  parseCleaningGrade,
  parseMasterWorkbook,
  quoteEaFor,
  quoteEaFormula,
  readWorkbook,
  roundQuoteEa,
} from '@engine/index'
import type { MasterCell, MasterData } from '@engine/index'

const dec = new TextDecoder()

describe('对客报价 Quote (EA) 取整', () => {
  it.each([
    [658.2, 660], // 普通：向上取到十位
    [650, 650],
    [287, 290],
    [290, 290],
    [290.01, 290], // 进到 300 → 归 290
    [296, 290],
    [300, 290],
    [304, 290], // 进到 310 → 归 290
    [310, 290],
    [310.01, 320],
    [1005, 990],
    [1088, 1090],
    [95, 90], // 100 附近同样归 90
    [110, 90],
    [111, 120],
    [89, 90],
    [8, 10], // 100 以下其余照常进位
    [26, 30],
    [2003, 1990],
  ])('%s → %s', (usd, want) => {
    expect(roundQuoteEa(usd)).toBe(want)
  })

  it('浮点误差不多进一档：670/6.7×4.2 = 420', () => {
    expect(roundQuoteEa((670 / 6.7) * 4.2)).toBe(420)
  })
})

describe('清洗等级识别', () => {
  it.each<[MasterCell, number | null]>([
    ['30级', 30],
    ['30级GP', 30],
    ['10级HV', 10],
    ['SPEC # 0577777-000 LEVEL 20', 20],
    ['SPECIFICATION,0577777-000, LEVEL 30', 30],
    ['SPECIFICATIONS\n0577777-000 LEVEL 10', 10],
    ['SPECIFICATION 0233944-000\nLevel 30', 30],
    ['EANING SPECIFICATION 0577777-XXX TO LEVE 10', 10],
    ['DOC 0577777-XXX - LEVEL 30.', 30],
    ['LEVEL 10 / LEVEL 30', 10], // 写了两个取最严的
    ['不详', null],
    ['SPECIFICATION 905-610019-001', null], // 编号里的 10 不算
    ['SPEC.0233944-000, CLASS GP.', null],
    ['0099999-XXX', null],
    ['LEVEL 100', null],
    [null, null],
  ])('%j → %s', (spec, want) => {
    expect(parseCleaningGrade(spec)).toBe(want)
  })
})

function rowWith(h: MasterCell, spec: MasterCell): MasterCell[] {
  const cells: MasterCell[] = KK_HEADERS.map(() => null)
  cells[KK_COL.quoteEach] = h
  cells[KK_COL.cleaningSpec] = spec
  return cells
}

describe('一行的对客报价', () => {
  it('H ÷ 6.7 × 等级系数再取整', () => {
    expect(quoteEaFor(rowWith(1050, '30级'))).toEqual({ value: 660, multiplier: 4.2 }) // 658.2
    expect(quoteEaFor(rowWith(1400, 'LEVEL 20'))).toEqual({ value: 950, multiplier: 4.5 }) // 940.3
    expect(quoteEaFor(rowWith(1600, '10级'))).toEqual({ value: 1150, multiplier: 4.8 }) // 1146.3
    expect(quoteEaFor(rowWith(480, '30级'))).toEqual({ value: 290, multiplier: 4.2 }) // 300.9 → 310 → 290
  })

  it('H 不是正数：不算', () => {
    expect(quoteEaFor(rowWith('TDB', '30级'))).toBeNull()
    expect(quoteEaFor(rowWith(null, '30级'))).toBeNull()
    expect(quoteEaFor(rowWith(0, '30级'))).toBeNull()
  })

  it('等级没写或认不出：按 30 级 ×4.2', () => {
    expect(quoteEaFor(rowWith(500, '不详'))).toEqual({ value: 320, multiplier: 4.2 }) // 313.4
    expect(quoteEaFor(rowWith(500, null))).toEqual({ value: 320, multiplier: 4.2 })
    expect(quoteEaFor(rowWith(500, 'SPEC.0233944-000, CLASS GP.'))).toEqual({ value: 320, multiplier: 4.2 })
  })

  it('Excel 公式：汇率和系数写在里面', () => {
    const f = quoteEaFormula('H2', 4.5)
    expect(f).toContain('H2/6.7*4.5')
    expect(f).toMatch(/^IF\(ISNUMBER\(H2\),/)
    expect(f).not.toContain('LET(') // 老版本 Excel 也能算
  })
})

/** 带表格样式的小汇总表，几行不同等级 / 价格 */
async function makeMaster(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('KK询价汇总')
  const specs: [MasterCell, MasterCell, MasterCell][] = [
    // H, Z, 原来的 U
    [1050, '30级', 658],
    [480, 'SPEC # 0577777-000 LEVEL 30', null],
    [1600, '10级', null],
    [500, '不详', 333], // 认不出等级：按 4.2 算
    ['TDB', '20级', null], // H 不是数字：不写公式
  ]
  ws.getRow(1).values = [...KK_HEADERS]
  specs.forEach(([h, z, u], i) => {
    const row: MasterCell[] = KK_HEADERS.map(() => null)
    row[0] = i + 1
    row[3] = `09${String(i).padStart(5, '0')}-000`
    row[KK_COL.quoteEach] = h
    row[KK_COL.cleaningSpec] = z
    row[KK_COL.quoteEa] = u
    ws.getRow(i + 2).values = row
  })
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer
}

function parse(buffer: ArrayBuffer): MasterData {
  const m = parseMasterWorkbook(readWorkbook(buffer), 'x.xlsx')
  expect(m).not.toBeNull()
  return m!
}

describe('比价页「总表格式」导出：U 列写公式', () => {
  it('以原表为模板：U 列是公式加算好的值，H 不是数字的行照原样', async () => {
    const original = await makeMaster()
    const master = parse(original)
    const out = await buildMasterSubsetWorkbook(master, [1, 0, 2, 3, 4], original, { quoteEaFormula: true })
    expect(out.mode).toBe('template')

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(out.buffer)
    const ws = wb.getWorksheet('KK询价汇总')!
    const u = (r: number) => ws.getCell(`U${r}`).value
    expect(u(2)).toEqual({ formula: quoteEaFormula('H2', 4.2), result: 290 })
    expect(u(3)).toEqual({ formula: quoteEaFormula('H3', 4.2), result: 660 })
    expect(u(4)).toEqual({ formula: quoteEaFormula('H4', 4.8), result: 1150 })
    expect(u(5)).toEqual({ formula: quoteEaFormula('H5', 4.2), result: 320 })
    expect(u(6)).toBeNull()
    // 其余列不动
    expect(ws.getCell('H3').value).toBe(1050)
    expect(ws.getCell('Z2').value).toBe('SPEC # 0577777-000 LEVEL 30')

    const sheet = dec.decode(unzipSync(new Uint8Array(out.buffer))['xl/worksheets/sheet1.xml']!)
    expect(sheet).toContain('MOD(CEILING(ROUND(H2/6.7*4.2,6),10),100)&lt;=10') // XML 转义
  })

  it('不开这个选项（主表「导出所选」）：U 列照总表原值', async () => {
    const original = await makeMaster()
    const master = parse(original)
    const out = await buildMasterSubsetWorkbook(master, [0, 1], original)
    const re = parse(out.buffer)
    expect(re.rows.map((r) => r.cells[KK_COL.quoteEa])).toEqual([658, null])
    expect(dec.decode(unzipSync(new Uint8Array(out.buffer))['xl/worksheets/sheet1.xml']!)).not.toContain('<f>')
  })

  it('没有原文件、从零重建时也写公式', async () => {
    const master = parse(await makeMaster())
    const out = await buildMasterSubsetWorkbook(master, [2, 3], null, { quoteEaFormula: true })
    expect(out.mode).toBe('fresh')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(out.buffer)
    const ws = wb.worksheets[0]!
    expect(ws.getCell('U2').value).toEqual({ formula: quoteEaFormula('H2', 4.8), result: 1150 })
    expect(ws.getCell('U3').value).toEqual({ formula: quoteEaFormula('H3', 4.2), result: 320 })
  })
})
