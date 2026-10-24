import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import { KK_COL_COUNT, copyColumns, copyRowCells, toExcelTsv, tsvCell, type MasterCell } from '@engine/index'

/** 只读账号看不到的列：O、P、Q、S（和 MainPage 一致） */
const VIEWER_HIDDEN = new Set([14, 15, 16, 18])
const NONE = new Set<number>()

/** 用 exceljs 的 CSV 读取（制表符分隔、双引号包裹）把剪贴板文本读回二维表，模拟贴进表格软件 */
async function parseLikeExcel(tsv: string): Promise<string[][]> {
  const wb = new ExcelJS.Workbook()
  const ws = await wb.csv.read(Readable.from([tsv]), {
    parserOptions: { delimiter: '\t', quote: '"' },
    map: (v: unknown) => v,
  })
  const out: string[][] = []
  ws.eachRow({ includeEmpty: true }, (r) => {
    const vals: string[] = []
    for (let c = 1; c <= ws.columnCount; c++) vals.push(String(r.getCell(c).value ?? ''))
    out.push(vals)
  })
  return out
}

function fullRow(fill: (c: number) => MasterCell): MasterCell[] {
  return Array.from({ length: KK_COL_COUNT }, (_, c) => fill(c))
}

describe('复制成表格：贴进汇总表 Excel 时列对得上', () => {
  it('整行复制：只读账号看不到的 O、P、Q、S 照样占一列、内容留空，共 34 列', () => {
    const cols = copyColumns(() => true, VIEWER_HIDDEN, KK_COL_COUNT)
    expect(cols).toEqual(Array.from({ length: KK_COL_COUNT }, (_, c) => c))
    const row = fullRow((c) => `v${c}`)
    const cells = copyRowCells(row, cols, VIEWER_HIDDEN)
    expect(cells).toHaveLength(KK_COL_COUNT)
    expect([cells[14], cells[15], cells[16], cells[18]]).toEqual([null, null, null, null])
    expect(cells[17]).toBe('v17') // R 材料费照常带上
    expect(cells[22]).toBe('v22') // W 交期还在 W
  })

  it('编辑账号没有隐藏列：整行原样复制', () => {
    const cols = copyColumns(() => true, NONE, KK_COL_COUNT)
    const row = fullRow((c) => c)
    expect(copyRowCells(row, cols, NONE)).toEqual(row)
  })

  it('选列/框选跨过隐藏列（屏幕上 N、R 挨着）：中间的 O、P、Q 留空占位', () => {
    // 只点了 N、R 两个表头
    expect(copyColumns((c) => c === 13 || c === 17, VIEWER_HIDDEN, KK_COL_COUNT)).toEqual([13, 14, 15, 16, 17])
    // 框选 R..T：中间的 S 占位
    expect(copyColumns((c) => c >= 17 && c <= 19, VIEWER_HIDDEN, KK_COL_COUNT)).toEqual([17, 18, 19])
    // 拖选表头时选区里本来就含隐藏列的下标，结果一样
    expect(copyColumns((c) => c >= 13 && c <= 17, VIEWER_HIDDEN, KK_COL_COUNT)).toEqual([13, 14, 15, 16, 17])
  })

  it('不连续的选列（D、F，中间 E 没选）照旧挤在一起；选区边上的隐藏列不带', () => {
    expect(copyColumns((c) => c === 3 || c === 5, VIEWER_HIDDEN, KK_COL_COUNT)).toEqual([3, 5])
    // 只选 N：右边的 O、P、Q 不算夹在中间
    expect(copyColumns((c) => c === 13, VIEWER_HIDDEN, KK_COL_COUNT)).toEqual([13])
    // 只选 R：左边 O、P、Q 和右边 S 都不带
    expect(copyColumns((c) => c === 17, VIEWER_HIDDEN, KK_COL_COUNT)).toEqual([17])
  })

  it('格子里有换行/制表符：读回来仍是一行 34 列，内容不变', async () => {
    const row = fullRow((c) => (c === 0 ? 1 : null))
    row[3] = '0100001-001'
    row[5] = 'MOUNT,X-STAGE OPTO FLAG,\r\nAPO'
    row[24] = 'ENGRAVE "KVS"\nRED ANODIZE'
    row[25] = '905-610019-001\t'
    row[29] = 'CLAMP 1/2" OD'
    const cols = copyColumns(() => true, VIEWER_HIDDEN, KK_COL_COUNT)
    const tsv = toExcelTsv([copyRowCells(row, cols, VIEWER_HIDDEN), copyRowCells(row, cols, VIEWER_HIDDEN)])
    const back = await parseLikeExcel(tsv)
    expect(back).toHaveLength(2)
    for (const r of back) {
      expect(r).toHaveLength(KK_COL_COUNT)
      expect(r[3]).toBe('0100001-001')
      expect(r[5]).toBe('MOUNT,X-STAGE OPTO FLAG,\nAPO')
      expect(r[24]).toBe('ENGRAVE "KVS"\nRED ANODIZE')
      expect(r[25]).toBe('905-610019-001 ')
      expect(r[29]).toBe('CLAMP 1/2" OD')
    }
  })

  it('单格写法：和 Excel 自己复制出来的一样', () => {
    expect(tsvCell(null)).toBe('')
    expect(tsvCell(56.7)).toBe('56.7')
    expect(tsvCell('3 weeks+cleaning')).toBe('3 weeks+cleaning')
    expect(tsvCell('a\r\nb')).toBe('"a\nb"')
    expect(tsvCell('1/2" OD\nM6')).toBe('"1/2"" OD\nM6"')
    expect(tsvCell('"quoted"')).toBe('"""quoted"""')
    expect(tsvCell('x\ty')).toBe('x y')
  })
})
