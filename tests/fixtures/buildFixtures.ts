/**
 * 合成测试固件：按三份真实样本的结构仿造（表头行位置、垃圾行列、#REF!、
 * ￥文本价、TDB、阶梯报价），但零件号/价格均为虚构，不含真实业务数据。
 */
import ExcelJS from 'exceljs'

export const FIXTURE_PNS = [
  '0100001-001',
  '0100002-000',
  '0100003-000',
  '0100004-001',
  '0100005-000',
  '0100006-000',
  '0100007-004',
  '0100008-002',
  '0100009-001',
]

export const FIXTURE_REVS = ['AA', '03', '01', '01', '01', '04', '04', 'AA', 'AA']

export const FIXTURE_DESCS = FIXTURE_PNS.map((_, i) => `PLATE, TEST PART ${i + 1}, FX`)

/** KV/凯阔风格价格（供应商把价填在 H 与 K"SKW"两列，值相同） */
export const FILE_A_PRICES = [45, 250, 225, 60, 350, 320, 220, 95, 30]

/** HC 风格价格（J 列 Quote Each RMB） */
export const FILE_B_PRICES = [56.7, 340, 17, 73.7, 56.7, 113.4, 113.4, 56.7, 68]

async function toArrayBuffer(wb: ExcelJS.Workbook): Promise<ArrayBuffer> {
  const buf = await wb.xlsx.writeBuffer()
  const u8 = new Uint8Array(buf as ArrayBuffer)
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

/**
 * 文件 A：KV/凯阔风格。表头第 1 行；价格在 H 与 K（表头 SKW）；
 * 数据 9 行后跟宏说明垃圾行（B 列 "Macro shortcut"、D 列 "Show all rows"）。
 */
export async function makeFileA(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Cost 2021A')
  ws.getRow(1).values = [
    'No.',
    'Name（询价人）',
    'Item',
    'P/N（零件编号）',
    'Rev（版本号）',
    'Description（描述）',
    "Q'ty",
    'Quote \n(each)',
    'Mao',
    'SZ-B',
    'SKW',
    'SZ-C',
    'JST',
    'JM',
    'INNO6 (US$)',
    'USD',
    'Cleaning',
    'Material Cost',
    'Shipping',
    'Cost',
    'Quote  (EA)',
    'Quote #',
    'Lead Time',
    'Material \n（材料）',
    'Surface Finish （表面处理）',
    'Cleaning清洗标准',
    'Method（工艺）',
    'Size（尺寸）',
    '备注',
  ]
  FIXTURE_PNS.forEach((pn, i) => {
    const r = ws.getRow(2 + i)
    r.getCell(1).value = i + 1
    r.getCell(2).value = '凯阔0711'
    r.getCell(3).value = i + 1
    r.getCell(4).value = pn
    r.getCell(5).value = FIXTURE_REVS[i]
    r.getCell(6).value = FIXTURE_DESCS[i]
    r.getCell(7).value = 10
    r.getCell(8).value = FILE_A_PRICES[i]
    r.getCell(11).value = FILE_A_PRICES[i]
    r.getCell(16).value = FILE_A_PRICES[i]! / 6.5
    r.getCell(21).value = Math.round(FILE_A_PRICES[i]! * 0.68) // U 对客报价（KV 家宏算好）
    r.getCell(22).value = 'KV202607133'
    r.getCell(23).value = '3 weeks+cleaning'
    r.getCell(24).value = i % 2 === 0 ? '304' : '6061'
    if (i === 4) r.getCell(29).value = '报价不含磁铁'
  })
  // 宏说明垃圾行（与真实样本一致，落在 B/C/D 列）
  ws.getRow(12).getCell(2).value = 'Macro shortcut'
  const macro: [string, string][] = [
    ['A', 'Show all rows'],
    ['B', 'Show all part numbers'],
    ['H', 'Hide Column H-T'],
    ['U', 'Unhide all'],
  ]
  macro.forEach(([key, text], i) => {
    const r = ws.getRow(13 + i)
    r.getCell(2).value = 'Ctl+'
    r.getCell(3).value = key
    r.getCell(4).value = text
  })
  ws.getRow(18).getCell(2).value = 'Ctl 5'
  ws.getRow(18).getCell(4).value = 'Font strike out'
  return toArrayBuffer(wb)
}

/**
 * 文件 B：HC 风格。第 1 行公司抬头，表头第 3 行；价格在 J "Quote Each RMB"；
 * A4 是 #REF! 错误单元格；K–R 是 " 2"…" 9" 垃圾列；交期 W 为纯数字天数。
 */
export async function makeFileB(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('报价单')
  ws.getCell('B1').value = 'HC Tech LLC Quoting Template (UPDATED 20260711)'
  const header = ws.getRow(3)
  header.values = [
    'No.',
    'Quote No.',
    'Item',
    'P/N',
    'Rev',
    'Description',
    "Q'ty",
    'Quote \n(each)',
    '',
    'Quote Each RMB',
    ' 2',
    ' 3',
    ' 4',
    ' 5',
    ' 6',
    ' 7',
    ' 8',
    ' 9',
    'Shipping/ Freight RMB',
    ' 11',
    'Column2',
    'Column1',
    'Lead Time (Calendar Days)',
    'Material \n（材料）',
    'Surface Finish （表面处理）',
    'Cleaning Spec',
    'Process',
    'Size',
    'Type',
    'Comments',
  ]
  FIXTURE_PNS.forEach((pn, i) => {
    const r = ws.getRow(4 + i)
    if (i === 0) r.getCell(1).value = { error: '#REF!' } as ExcelJS.CellErrorValue
    r.getCell(2).value = 'KT20260711B'
    r.getCell(3).value = i + 1
    r.getCell(4).value = pn
    r.getCell(5).value = FIXTURE_REVS[i]
    r.getCell(6).value = FIXTURE_DESCS[i]
    r.getCell(7).value = 10
    r.getCell(10).value = FILE_B_PRICES[i]
    r.getCell(23).value = 22
    r.getCell(24).value = i % 2 === 0 ? '304 SS' : 'ALUMINUM 6061-T6'
  })
  return toArrayBuffer(wb)
}

/**
 * 文件 C：KK 汇总风格节选。同一 P/N 按数量 1/2/5 阶梯报价、
 * ￥文本价、TDB、$文本价（尾带 nbsp）。
 */
export async function makeFileC(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('KK询价汇总')
  ws.getRow(1).values = [
    'No.',
    'Name',
    'Item',
    'P/N',
    'Rev',
    'Description',
    "Q'ty",
    'Quote \n(each)',
    'Mao',
    'HC',
    'SKW',
    'BY',
    'YJ',
    'JM',
    'US Vendor (US$)',
    'USD',
    'Cleaning',
    'Material Cost',
    'Shipping+Tariff',
    'Cost',
    'Quote  (EA)',
    'Quote #',
    'Lead Time',
  ]
  const rows: [string, string, number, string | number, string][] = [
    ['0200001-000', 'AA', 1, '￥1,360.00', '15Days'],
    ['0200001-000', 'AA', 2, '￥1,133.40', '18Days'],
    ['0200001-000', 'AA', 5, 680, '22Days'],
    ['0200002-000', 'AA', 2, 'TDB', ''],
    ['0200003-001', 'AB', 3, '$935.00 ', '2-3 days'],
  ]
  rows.forEach(([pn, rev, qty, price, lead], i) => {
    const r = ws.getRow(2 + i)
    r.getCell(1).value = i + 1
    r.getCell(2).value = '20260717 Test'
    r.getCell(4).value = pn
    r.getCell(5).value = rev
    r.getCell(7).value = qty
    r.getCell(10).value = price
    if (lead) r.getCell(23).value = lead
  })
  return toArrayBuffer(wb)
}

/**
 * KK 汇总固件：表头 33 列 + 2 行既有数据 + 3 行只有 A 列序号的预编号空行 + NEGO 透传 sheet。
 * R2 与文件 A 的第一个零件同 P/N 同数量、HC(J) 已报、SKW(K) 空 —— 供"填充既有行"用例。
 */
export async function makeMasterFile(): Promise<ArrayBuffer> {
  const { KK_HEADERS } = await import('@engine/export/kkLayout')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('KK询价汇总')
  ws.getRow(1).values = [...KK_HEADERS]
  const r2 = ws.getRow(2)
  r2.getCell(1).value = 1
  r2.getCell(2).value = '20260801 Old'
  r2.getCell(3).value = 1
  r2.getCell(4).value = FIXTURE_PNS[0] // 0100001-001
  r2.getCell(5).value = 'AA'
  r2.getCell(6).value = FIXTURE_DESCS[0]
  r2.getCell(7).value = 10
  r2.getCell(10).value = 56.7 // J HC 已报
  r2.getCell(23).value = '22Days'
  const r3 = ws.getRow(3)
  r3.getCell(1).value = 2
  r3.getCell(2).value = '20260801 Old'
  r3.getCell(4).value = '0900001-000'
  r3.getCell(5).value = 'AA'
  r3.getCell(7).value = 5
  r3.getCell(8).value = 90
  r3.getCell(10).value = '￥100.00' // 历史遗留文本金额（导入时应被自动规范为 100）
  r3.getCell(11).value = 90
  for (let i = 0; i < 3; i++) ws.getRow(4 + i).getCell(1).value = 3 + i // 预编号空行 A=3..5
  const nego = wb.addWorksheet('NEGO')
  nego.getCell('B1').value = 'Basis For Negotiation'
  nego.getCell('A2').value = 'marker'
  return toArrayBuffer(wb)
}

/** 双 sheet 工作簿：第一个 sheet 是空说明页，真数据在第二个 sheet（自动选 sheet 用例） */
export async function makeMultiSheet(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  const cover = wb.addWorksheet('说明')
  cover.getCell('A1').value = '本工作簿仅测试用'
  const ws = wb.addWorksheet('Quote')
  ws.getRow(1).values = ['P/N', 'Rev', "Q'ty", '单价', '交期']
  ws.getRow(2).values = ['0300001-000', 'AA', 5, 120, '7天']
  ws.getRow(3).values = ['0300002-000', 'AB', 2, 260, '10天']
  return toArrayBuffer(wb)
}
