import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import {
  COPY_BAND_FILLS,
  KK_COL,
  KK_COL_COUNT,
  VIEWER_HIDDEN_COLS,
  cellsToClipboard,
  copyColumns,
  copyRowCells,
  hiddenColsFor,
  masterRowsToClipboard,
  toExcelHtml,
  toExcelTsv,
  tsvCell,
  type MasterCell,
  type MasterRow,
} from '@engine/index'

const VIEWER_HIDDEN = VIEWER_HIDDEN_COLS
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

/** 选整行复制出来的第 k 格对应汇总表的列：从 B 列起，下标比汇总表列号小 1 */
const B = (col: number): number => col - 1

/** 剪贴板 HTML → 每行每格的 { style, html } */
function parseHtml(html: string): { style: string; html: string }[][] {
  return [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((tr) =>
    [...tr[1]!.matchAll(/<td style="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g)].map((td) => ({ style: td[1]!, html: td[2]! })),
  )
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

  it('编辑账号没有隐藏列：整行原样复制，只有 U 列换成现算的对客价', () => {
    const cols = copyColumns(() => true, NONE, KK_COL_COUNT)
    const row = fullRow((c) => c)
    const out = copyRowCells(row, cols, NONE)
    expect(out.filter((_, c) => c !== KK_COL.quoteEa)).toEqual(row.filter((_, c) => c !== KK_COL.quoteEa))
    expect(out[KK_COL.quoteEa]).toBe(10) // H = 7：7 ÷ 6.7 × 4.2 ≈ 4.4 → 10
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

  it('汇总表整行（主表选行、比价页「总表格式」复制）：从 B 列批次起 33 列，只读账号的 O、P、Q、S 留空', async () => {
    const row = fullRow((c) => `v${c}`)
    row[5] = 'BRACKET,\nAPO'
    const rows: MasterRow[] = [{ cells: row }, { cells: fullRow((c) => (c === 19 ? 88 : null)) }]
    const viewer = await parseLikeExcel(masterRowsToClipboard(rows, VIEWER_HIDDEN_COLS).text)
    expect(viewer).toHaveLength(2)
    expect(viewer[0]).toHaveLength(KK_COL_COUNT - 1)
    expect(viewer[0]![0]).toBe('v1') // 第一格是 B 列批次，A 列序号不带
    expect(viewer[0]![B(19)]).toBe('v19') // T Cost
    expect(viewer[1]![B(19)]).toBe('88')
    expect([14, 15, 16, 18].map((c) => viewer[0]![B(c)])).toEqual(['', '', '', ''])
    expect(viewer[0]![B(5)]).toBe('BRACKET,\nAPO')
    expect(viewer[0]![B(33)]).toBe('v33') // 最后一格 AH Base ID
    const editor = await parseLikeExcel(masterRowsToClipboard(rows, NONE).text)
    expect(editor[0]![B(15)]).toBe('v15')
  })

  it('U 列对客价表格里不显示，复制时按 H 列和清洗等级现算（不拿存的旧值）', async () => {
    expect([...hiddenColsFor(false)]).toEqual([20])
    expect([...hiddenColsFor(true)].sort((a, b) => a - b)).toEqual([14, 15, 16, 18, 20])
    const row = (h: MasterCell, spec: MasterCell): MasterCell[] => {
      const cells = fullRow((c) => `v${c}`)
      cells[KK_COL.quoteEach] = h
      cells[KK_COL.cleaningSpec] = spec
      cells[KK_COL.quoteEa] = 999 // 种子表里的旧值，不该出现
      return cells
    }
    const rows: MasterRow[] = [
      { cells: row(670, '20级') }, // 670 ÷ 6.7 × 4.5 = 450
      { cells: row(670, '不详') }, // 认不出等级按 ×4.2 = 420
      { cells: row((296 * 6.7) / 4.8, 'Level 10') }, // 296 → 300 → 归 290
      { cells: row('TDB', '30级') }, // H 是文字：留空
      { cells: row(null, '30级') }, // H 空着：留空
    ]
    for (const readOnly of [false, true]) {
      const back = await parseLikeExcel(masterRowsToClipboard(rows, hiddenColsFor(readOnly)).text)
      expect(back.map((r) => r[B(20)])).toEqual(['450', '420', '290', '', ''])
      expect(back[0]![B(19)]).toBe('v19') // T、V 照常
      expect(back[0]![B(21)]).toBe('v21')
    }
    // 框选 T..V：中间的 U 也现算
    expect(copyColumns((c) => c >= 19 && c <= 21, hiddenColsFor(false), KK_COL_COUNT)).toEqual([19, 20, 21])
    const range = cellsToClipboard([row(670, '20级')], (c) => c >= 19 && c <= 21, hiddenColsFor(false))
    expect(range.text).toBe('v19\t450\tv21')
    // 只选 T 列：U 不夹在中间，不带
    expect(cellsToClipboard([row(670, '20级')], (c) => c === 19, hiddenColsFor(false)).text).toBe('v19')
  })

  it('HTML 表格：照汇总表的样子，蓝白隔行、Arial 14 号、居中、细边框', () => {
    const rows: MasterRow[] = [0, 1, 2].map((i) => ({ cells: fullRow((c) => (c === 1 ? `KK2026103${i}` : null)) }))
    const { html } = masterRowsToClipboard(rows, hiddenColsFor(false))
    const parsed = parseHtml(html)
    expect(parsed).toHaveLength(3)
    for (const tr of parsed) expect(tr).toHaveLength(KK_COL_COUNT - 1)
    expect(parsed.map((tr) => tr[0]!.html)).toEqual(['KK20261030', 'KK20261031', 'KK20261032'])
    expect(COPY_BAND_FILLS).toEqual(['#D9E1F2', '#FFFFFF'])
    // 第一行浅蓝、第二行白、第三行又是浅蓝；空格子也有底色和边框，条纹不断
    expect(parsed.map((tr) => tr.every((td) => td.style.includes(`background:${COPY_BAND_FILLS[0]}`)))).toEqual([
      true,
      false,
      true,
    ])
    expect(parsed[1]!.every((td) => td.style.includes(`background:${COPY_BAND_FILLS[1]}`))).toBe(true)
    expect(html).toContain(`bgcolor="${COPY_BAND_FILLS[0]}" align="center" valign="middle"`)
    for (const td of parsed.flat()) {
      expect(td.style).toContain('font-family:Arial;font-size:14pt')
      expect(td.style).toContain('text-align:center;vertical-align:middle')
      expect(td.style).toContain('border:.5pt solid windowtext')
    }
  })

  it('HTML 表格：金额格式和原表一样（HC/SKW/CL/YJ 是 ¥，U 是 $），文字按文本贴，换行留在格内', () => {
    const cells = fullRow(() => null)
    cells[KK_COL.name] = 'KK20261030'
    cells[KK_COL.pn] = '0099999'
    cells[KK_COL.rev] = '01'
    cells[KK_COL.description] = 'PLATE, <TOP> & "SIDE"\r\nAPO'
    cells[KK_COL.qty] = 10
    cells[KK_COL.quoteEach] = 670
    cells[8] = 700 // I Mao：原表是常规格式
    cells[9] = 640.5 // J HC
    cells[10] = 'TDB' // K SKW 文字
    cells[11] = 670 // L CL
    cells[KK_COL.yj] = 680 // AG YJ
    cells[KK_COL.leadTime] = '3-5'
    cells[KK_COL.cleaningSpec] = '20级'
    const [tr] = parseHtml(
      toExcelHtml([copyRowCells(cells, [...Array(KK_COL_COUNT).keys()], NONE)], [...Array(KK_COL_COUNT).keys()]),
    )
    const td = (col: number) => tr![col]!
    const yuan = String.raw`mso-number-format:'\0022\00A5\0022\#\,\#\#0\.00'`
    const usd = String.raw`mso-number-format:'\0022$\0022\#\,\#\#0\.00'`
    const text = String.raw`mso-number-format:'\@'`
    expect([td(9), td(11), td(KK_COL.yj)].map((t) => [t.html, t.style.includes(yuan)])).toEqual([
      ['640.5', true],
      ['670', true],
      ['680', true],
    ])
    expect(td(KK_COL.quoteEa).html).toBe('450')
    expect(td(KK_COL.quoteEa).style).toContain(usd)
    for (const col of [KK_COL.qty, KK_COL.quoteEach, 8]) {
      expect(td(col).style).toContain("mso-number-format:'General'")
    }
    // 文字（含看着像数字/日期的编号、版本、交期）都按文本贴，不被 Excel 改成 99999、1、5月3日
    for (const col of [KK_COL.pn, KK_COL.rev, KK_COL.leadTime, 10]) expect(td(col).style).toContain(text)
    expect(td(KK_COL.pn).html).toBe('0099999')
    expect(td(KK_COL.description).html).toBe(
      'PLATE, &lt;TOP&gt; &amp; &quot;SIDE&quot;<br style="mso-data-placement:same-cell">APO',
    )
    // 空格子不写格式
    expect(td(KK_COL.comment).html).toBe('')
    expect(td(KK_COL.comment).style).not.toContain('mso-number-format')
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
