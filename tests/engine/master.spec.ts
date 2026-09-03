import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { makeFileA, makeMasterFile, FIXTURE_PNS } from '../fixtures/buildFixtures'
import { makeQuote } from '../fixtures/rows'
import {
  KK_COL,
  KK_HEADERS,
  applyMerge,
  buildMasterWorkbook,
  deleteMasterRows,
  guessBatchLabel,
  isMasterWorkbook,
  isPlaceholderRow,
  isRealQuoteNo,
  negoSummaryFromInputs,
  parseMasterWorkbook,
  planMerge,
  readWorkbook,
} from '@engine/index'
import type { MasterData } from '@engine/index'

async function loadMaster(): Promise<MasterData> {
  const pw = readWorkbook(await makeMasterFile())
  const master = parseMasterWorkbook(pw, 'KK汇总测试.xlsm')
  expect(master).not.toBeNull()
  return master!
}

describe('汇总表解析', () => {
  it('识别汇总工作簿、拆行、透传 NEGO、识别预编号空行', async () => {
    const master = await loadMaster()
    expect(master.sheetName).toBe('KK询价汇总')
    expect(master.rows).toHaveLength(5) // 2 数据行 + 3 预编号空行
    expect(master.rows[0]!.cells[KK_COL.pn]).toBe(FIXTURE_PNS[0])
    expect(master.rows[0]!.cells[9]).toBe(56.7)
    expect(isPlaceholderRow(master.rows[2]!)).toBe(true)
    expect(master.passthrough.map((s) => s.name)).toEqual(['NEGO'])
    expect(master.passthrough[0]!.grid[0]![1]).toBe('Basis For Negotiation')
    // 报价文件不会被误判为汇总
    expect(isMasterWorkbook(readWorkbook(await makeFileA()))).toBe(false)
  })
})

describe('合并规则', () => {
  it('真单号判定与批次猜测', () => {
    expect(isRealQuoteNo('KV202608151')).toBe(true)
    expect(isRealQuoteNo('KT20260711B')).toBe(true)
    expect(isRealQuoteNo('询价 20260814 Natalie A')).toBe(false)
    expect(guessBatchLabel([makeQuote('X', { quoteNo: '询价 20260814 Natalie A' })], 'x.xlsx')).toBe(
      '20260814 Natalie A',
    )
    expect(guessBatchLabel([makeQuote('X')], 'HCQuote_询价_20260814_Natalie_A.xlsx')).toBe(
      '20260814 Natalie A',
    )
    expect(guessBatchLabel([makeQuote('X', { quoteNo: 'KV202608151' })], 'KV202608153.xlsx')).toBe('')
  })

  it('SKW 报价：填充既有行（K 列、W 追加在后、V 真单号、H/U 取自带 Quote(EA) 的文件）', async () => {
    const master = await loadMaster()
    const quote = makeQuote(FIXTURE_PNS[0]!, {
      qty: 10,
      amount: 45,
      lead: '3 weeks+cleaning',
      quoteNo: 'KV202608151',
      quoteEa: '31',
      item: '1',
      material: '304',
    })
    const plan = planMerge(master, [quote], {
      batch: '20260814 Test',
      vendorSlot: 10,
      vendorId: 'skw',
      vendorDisplay: 'SKW',
    })
    expect(plan.fillCount).toBe(1)
    expect(plan.appendCount).toBe(0)
    const merged = applyMerge(master, plan)
    const row = merged.rows[0]!
    expect(row.cells[10]).toBe(45) // K
    expect(row.cells[KK_COL.leadTime]).toBe('22Days/3 weeks+cleaning') // K 在 J 之后 → 追加
    expect(row.cells[KK_COL.quoteNo]).toBe('KV202608151')
    expect(row.cells[KK_COL.quoteEach]).toBe(45) // H 只因带 quoteEa 才填
    expect(row.cells[KK_COL.quoteEa]).toBe(31)
    expect(row.cells[KK_COL.material]).toBe('304')
    // 原对象不被修改
    expect(master.rows[0]!.cells[10]).toBeNull()
  })

  it('HC 报价：J 列在前 → W 前插；无 Quote(EA) 不动 H/U；批次标签不进 V', async () => {
    const master = await loadMaster()
    // 先造一行只有 SKW 报过的行
    master.rows[0]!.cells[9] = null
    master.rows[0]!.cells[10] = 45
    master.rows[0]!.cells[KK_COL.leadTime] = '3 weeks+cleaning'
    const quote = makeQuote(FIXTURE_PNS[0]!, {
      qty: 10,
      amount: 56.7,
      lead: '22',
      quoteNo: '询价 20260814 Natalie A',
    })
    const plan = planMerge(master, [quote], {
      batch: '20260814 Natalie A',
      vendorSlot: 9,
      vendorId: 'hc',
      vendorDisplay: 'HC',
    })
    const merged = applyMerge(master, plan)
    const row = merged.rows[0]!
    expect(row.cells[9]).toBe(56.7)
    expect(row.cells[KK_COL.leadTime]).toBe('22Days/3 weeks+cleaning') // J 在前 → 前插
    expect(row.cells[KK_COL.quoteNo]).toBeNull() // 批次标签不算真单号
    expect(row.cells[KK_COL.quoteEach]).toBeNull() // 无 quoteEa 不填 H
  })

  it('TDB 占位可回填 + 同零件同数量多行按材料对齐（中文/空格归一化）', () => {
    const mk = (vals: Record<number, string | number>): { cells: (string | number | null)[] } => {
      const cells = Array.from({ length: 33 }, () => null as string | number | null)
      for (const [k, v] of Object.entries(vals)) cells[Number(k)] = v
      return { cells }
    }
    const master: MasterData = {
      rows: [
        mk({ 0: 1, 1: 'B', 3: 'X-1', 6: 1, 7: 'TDB', 9: 100, 10: 'TDB', 23: 'Invar-36' }),
        mk({ 0: 2, 1: 'B', 3: 'X-1', 6: 1, 7: 'TDB', 9: 60, 10: 'TDB', 23: 'SS-416' }),
        mk({ 0: 3, 1: 'B', 3: 'X-1', 6: 1, 7: 'TDB', 9: 55, 10: 'TDB', 23: 'SS-303' }),
      ],
      sheetName: 'KK询价汇总',
      passthrough: [],
      sourceFileName: null,
      importedAt: null,
    }
    // KV 回单顺序与材料写法都不同：殷钢(中文,不匹配→兜底) / SS 416 / SS 303（空格 vs 连字符）
    const quotes = [
      makeQuote('X-1', { qty: 1, amount: 15000, material: '殷钢 36', quoteEa: '9242', quoteNo: 'KV202608201' }),
      makeQuote('X-1', { qty: 1, amount: 6500, material: 'SS 416', quoteEa: '4012', quoteNo: 'KV202608201' }),
      makeQuote('X-1', { qty: 1, amount: 6500, material: 'SS 303', quoteEa: '4012', quoteNo: 'KV202608201' }),
    ]
    const plan = planMerge(master, quotes, {
      batch: '20260818 Coen',
      vendorSlot: 10,
      vendorId: 'skw',
      vendorDisplay: 'SKW',
    })
    expect(plan.fillCount).toBe(3) // K=TDB 占位可回填，不再另起新行
    expect(plan.appendCount).toBe(0)
    const merged = applyMerge(master, plan)
    expect(merged.rows[1]!.cells[10]).toBe(6500) // SS 416 → SS-416 行
    expect(merged.rows[2]!.cells[10]).toBe(6500) // SS 303 → SS-303 行
    expect(merged.rows[0]!.cells[10]).toBe(15000) // 殷钢材料名对不上 → 兜底落剩余 Invar 行
    expect(merged.rows[0]!.cells[7]).toBe(15000) // H 的 TDB 也被替换
    expect(merged.rows[1]!.cells[20]).toBe(4012) // U 对客价带入
  })

  it('找不到可填行 → 依次占用预编号空行（保留 A 序号），用完后续号新增', async () => {
    const master = await loadMaster()
    const quotes = [
      makeQuote('NEW-1', { qty: 3, amount: 100, item: '1', quoteNo: 'KV202608152', quoteEa: '64' }),
      makeQuote('NEW-2', { qty: 3, amount: 200, item: '2', quoteNo: 'KV202608152', quoteEa: '128' }),
      makeQuote('NEW-3', { qty: 3, amount: 300, item: '3', quoteNo: 'KV202608152', quoteEa: '192' }),
      makeQuote('NEW-4', { qty: 3, amount: 400, item: '4', quoteNo: 'KV202608152', quoteEa: '256' }),
    ]
    const plan = planMerge(master, quotes, {
      batch: '20260815 Batch',
      vendorSlot: 10,
      vendorId: 'skw',
      vendorDisplay: 'SKW',
    })
    expect(plan.fillCount).toBe(0)
    expect(plan.appendCount).toBe(4)
    const merged = applyMerge(master, plan)
    expect(merged.rows).toHaveLength(6) // 5 + 超出预编号的 1 行
    expect(merged.rows[2]!.cells[0]).toBe(3) // 预编号 A 保留
    expect(merged.rows[2]!.cells[KK_COL.pn]).toBe('NEW-1')
    expect(merged.rows[2]!.cells[KK_COL.name]).toBe('20260815 Batch')
    expect(merged.rows[5]!.cells[0]).toBe(6) // 新行续号
    expect(merged.rows[5]!.cells[KK_COL.pn]).toBe('NEW-4')
    // 同一 P/N 不同数量档各占一行、互不影响
    const tierPlan = planMerge(merged, [makeQuote('NEW-1', { qty: 9, amount: 80 })], {
      batch: 'X',
      vendorSlot: 10,
      vendorId: 'skw',
      vendorDisplay: 'SKW',
    })
    expect(tierPlan.appendCount).toBe(1)
  })
})

describe('并入智能化（0823/0826/0828 实证规则）', () => {
  const mk = (vals: Record<number, string | number>): { cells: (string | number | null)[] } => {
    const cells = Array.from({ length: 33 }, () => null as string | number | null)
    for (const [k, v] of Object.entries(vals)) cells[Number(k)] = v
    return { cells }
  }
  const base = (rows: { cells: (string | number | null)[] }[]): MasterData => ({
    rows,
    sheetName: 'KK询价汇总',
    passthrough: [],
    sourceFileName: null,
    importedAt: null,
  })
  const HC = { vendorSlot: 9, vendorId: 'hc', vendorDisplay: 'HC' }

  it('重复拖入已并入的回单 → 全部 skip，不产生任何改动', () => {
    const master = base([
      mk({ 0: 1, 1: '20260819 Bo', 3: 'D-1', 6: 2, 9: 1356, 10: 1235, 22: '7Days/3 weeks+cleaning' }),
    ])
    const plan = planMerge(master, [makeQuote('D-1', { qty: 2, amount: 1235, lead: '3 weeks+cleaning' })], {
      batch: '20260819 Bo',
      vendorSlot: 10,
      vendorId: 'skw',
      vendorDisplay: 'SKW',
    })
    expect(plan.skipCount).toBe(1)
    expect(plan.fillCount).toBe(0)
    expect(plan.appendCount).toBe(0)
    expect(plan.actions[0]!.changes).toHaveLength(0)
    expect(applyMerge(master, plan).rows).toHaveLength(1)
    // K 列是 '￥1,235.00' 文本时同样识别为一致
    const master2 = base([mk({ 0: 1, 1: '20260819 Bo', 3: 'D-1', 6: 2, 10: '￥1,235.00' })])
    expect(
      planMerge(master2, [makeQuote('D-1', { qty: 2, amount: 1235 })], {
        batch: '20260819 Bo',
        vendorSlot: 10,
        vendorId: 'skw',
        vendorDisplay: 'SKW',
      }).skipCount,
    ).toBe(1)
  })

  it('同批次修订：价格变 → revise 原位更新，不追加', () => {
    const master = base([mk({ 0: 1, 1: 'K', 3: 'R-1', 6: 5, 9: 170, 22: '90Days' })])
    const plan = planMerge(master, [makeQuote('R-1', { qty: 5, amount: 200, lead: '90' })], {
      batch: 'K',
      ...HC,
    })
    expect(plan.reviseCount).toBe(1)
    expect(plan.appendCount).toBe(0)
    const row = applyMerge(master, plan).rows[0]!
    expect(row.cells[9]).toBe(200)
    expect(row.cells[6]).toBe(5)
    expect(plan.warnings.some((w) => w.includes('修订'))).toBe(true)
  })

  it('整单重发（Kit 0826 场景）：一致行 skip、数量+价格变的行 revise 改档', () => {
    const master = base([
      mk({ 0: 1, 1: 'Kit X', 3: 'K-1', 6: 44, 9: 3700, 22: '90Days' }),
      mk({ 0: 2, 1: 'Kit X', 3: 'K-2', 6: 88, 9: 170, 22: '90Days' }),
    ])
    const plan = planMerge(
      master,
      [
        makeQuote('K-1', { qty: 44, amount: 3700, lead: '90' }),
        makeQuote('K-2', { qty: 44, amount: 200, lead: '90' }),
      ],
      { batch: 'Kit X', ...HC },
    )
    expect(plan.skipCount).toBe(1)
    expect(plan.reviseCount).toBe(1)
    expect(plan.appendCount).toBe(0)
    const rows = applyMerge(master, plan).rows
    expect(rows).toHaveLength(2)
    expect(rows[1]!.cells[6]).toBe(44) // 88 → 44
    expect(rows[1]!.cells[9]).toBe(200) // 170 → 200
  })

  it('单发一行数量不同（无整单重发上下文）→ 视为新数量档追加，不改原行', () => {
    const master = base([mk({ 0: 1, 1: 'V', 3: 'T-1', 6: 2, 9: 1200 })])
    const plan = planMerge(master, [makeQuote('T-1', { qty: 4, amount: 650 })], { batch: 'V', ...HC })
    expect(plan.reviseCount).toBe(0)
    expect(plan.appendCount).toBe(1)
    const rows = applyMerge(master, plan).rows
    expect(rows[0]!.cells[6]).toBe(2)
    expect(rows[0]!.cells[9]).toBe(1200)
  })

  it('数量修订遇到其他家已报价 → 不动原行，按新行并入并提醒', () => {
    const master = base([
      mk({ 0: 1, 1: 'B2', 3: 'M-1', 6: 88, 9: 170, 10: 500 }), // K 列凯阔已报
      mk({ 0: 2, 1: 'B2', 3: 'M-2', 6: 3, 9: 100 }),
    ])
    const plan = planMerge(
      master,
      [
        makeQuote('M-2', { qty: 3, amount: 100 }), // 一致 → skip（提供整单上下文）
        makeQuote('M-1', { qty: 44, amount: 200 }),
      ],
      { batch: 'B2', ...HC },
    )
    expect(plan.skipCount).toBe(1)
    expect(plan.reviseCount).toBe(0)
    expect(plan.appendCount).toBe(1)
    expect(plan.warnings.some((w) => w.includes('其他家报价'))).toBe(true)
    expect(applyMerge(master, plan).rows[0]!.cells[6]).toBe(88)
  })

  it('KV 修订：H/U 来自同家（H=修订前槽位值）时跟随更新', () => {
    const master = base([mk({ 0: 1, 1: 'KV1', 3: 'E-1', 6: 2, 7: 1235, 10: 1235, 20: 772 })])
    const plan = planMerge(
      master,
      [makeQuote('E-1', { qty: 2, amount: 1300, quoteEa: '810', quoteNo: 'KV202609011' })],
      { batch: 'KV1', vendorSlot: 10, vendorId: 'skw', vendorDisplay: 'SKW' },
    )
    expect(plan.reviseCount).toBe(1)
    const row = applyMerge(master, plan).rows[0]!
    expect(row.cells[10]).toBe(1300)
    expect(row.cells[7]).toBe(1300) // H 跟随
    expect(row.cells[20]).toBe(810) // U 跟随
    expect(row.cells[KK_COL.quoteNo]).toBe('KV202609011')
  })

  it('修订交期变化：W 不自动改，出提醒', () => {
    const master = base([mk({ 0: 1, 1: 'W1', 3: 'L-1', 6: 5, 9: 100, 22: '25Days/3 weeks' })])
    const plan = planMerge(master, [makeQuote('L-1', { qty: 5, amount: 120, lead: '30' })], {
      batch: 'W1',
      ...HC,
    })
    expect(plan.reviseCount).toBe(1)
    expect(applyMerge(master, plan).rows[0]!.cells[22]).toBe('25Days/3 weeks')
    expect(plan.warnings.some((w) => w.includes('修订交期'))).toBe(true)
  })

  it('跨批次重询（0828 Valeryan 场景）：按新行并入 + 点名历史批次', () => {
    const master = base([mk({ 0: 1, 1: '20260726 Valeryan', 3: 'Q-1', 6: 10, 9: 453, 10: 500 })])
    const plan = planMerge(master, [makeQuote('Q-1', { qty: 10, amount: 339 })], {
      batch: '20260827 Valeryan',
      ...HC,
    })
    expect(plan.appendCount).toBe(1)
    expect(plan.reviseCount).toBe(0)
    expect(plan.warnings.some((w) => w.includes('重询') && w.includes('20260726 Valeryan'))).toBe(true)
  })

  it('整行未识别到价格（0823 Bhupen 场景）→ 警告提醒', () => {
    const master = base([])
    const plan = planMerge(master, [makeQuote('N-1', { qty: 8 }), makeQuote('N-2', { qty: 8 })], {
      batch: '20260822 Bhupen',
      ...HC,
    })
    expect(plan.appendCount).toBe(2)
    expect(plan.warnings.some((w) => w.includes('未识别到价格') && w.includes('N-1'))).toBe(true)
  })
})

describe('汇总导出', () => {
  it('无原文件：从零重建（表头逐字节 + 数据 + NEGO 透传）', async () => {
    const master = await loadMaster()
    const out = await buildMasterWorkbook(master, null)
    expect(out.mode).toBe('fresh')
    expect(out.extension).toBe('xlsx')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(out.buffer)
    const ws = wb.getWorksheet('KK询价汇总')!
    KK_HEADERS.forEach((h, i) => expect(ws.getRow(1).getCell(i + 1).value).toBe(h))
    expect(ws.getCell('D2').value).toBe(FIXTURE_PNS[0])
    expect(ws.getCell('J2').value).toBe(56.7)
    expect(wb.getWorksheet('NEGO')!.getCell('B1').value).toBe('Basis For Negotiation')
  })

  it('删行后补丁导出：后续行上移、A 重排、原尾行清空、行数收缩', async () => {
    const original = await makeMasterFile()
    const master = parseMasterWorkbook(readWorkbook(original), 'm.xlsx')!
    const next = deleteMasterRows(master, [0]) // 删第一条数据行
    expect(next.rows).toHaveLength(4)
    const out = await buildMasterWorkbook(next, original)
    expect(out.mode).toBe('patch')
    const re = parseMasterWorkbook(readWorkbook(out.buffer), 'x.xlsx')!
    expect(re.rows).toHaveLength(4) // 原第 6 行被整行清空 → 尾部裁剪
    expect(re.rows[0]!.cells[KK_COL.pn]).toBe('0900001-000') // 原第 2 条数据上移
    expect(re.rows[0]!.cells[KK_COL.quoteEach]).toBe(90)
    expect(re.rows.map((r) => r.cells[0])).toEqual([1, 2, 3, 4]) // A 重排
    expect(re.passthrough.map((s) => s.name)).toEqual(['NEGO'])
  })

  it('有原文件：以原工作簿为底只改汇总数据（编辑与合并结果写回、NEGO 保留）', async () => {
    const original = await makeMasterFile()
    const master = parseMasterWorkbook(readWorkbook(original), 'm.xlsm')!
    master.rows[0]!.cells[9] = 999.5 // 模拟编辑 J2
    const out = await buildMasterWorkbook(master, original)
    expect(out.mode).toBe('patch')
    expect(out.extension).toBe('xlsx') // 固件由 exceljs 生成，标准内容类型
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(out.buffer)
    const ws = wb.getWorksheet('KK询价汇总')!
    expect(ws.getCell('J2').value).toBe(999.5)
    expect(ws.getCell('H3').value).toBe(90) // 未动的行保持
    expect(wb.getWorksheet('NEGO')!.getCell('A2').value).toBe('marker')
  })

  it('导出时把比价内容写进 NEGO sheet（补丁路径）；再次导出按表头行定位并收缩旧明细', async () => {
    const original = await makeMasterFile()
    const master = parseMasterWorkbook(readWorkbook(original), 'm.xlsx')!
    const nego = negoSummaryFromInputs(master, [
      { pn: FIXTURE_PNS[0]!, qty: 10 },
      { pn: '0900001-000', qty: 5 },
      { pn: 'NOPE-1', qty: 3 }, // 总表里没有 → 不计入
    ])
    expect(nego.lines).toHaveLength(2)
    const out = await buildMasterWorkbook(master, original, { nego })
    expect(out.mode).toBe('patch')
    expect(out.negoRowsWritten).toBe(2)
    expect(out.negoSheetName).toBe('NEGO')
    const re = parseMasterWorkbook(readWorkbook(out.buffer), 'o.xlsx')!
    expect(re.rows[0]!.cells[9]).toBe(56.7) // 汇总 sheet 未动
    const g = re.passthrough.find((s) => s.name === 'NEGO')!.grid
    expect(g[0]![1]).toBe('Basis For Negotiation') // 标题保留
    expect(g[1]![0]).toBe('marker')
    expect(g[2]!.slice(0, 4)).toEqual(['P/N', 'Rev', 'Description', "Q'ty"]) // 无表头 → 第 3 行起
    expect(g[3]![0]).toBe(FIXTURE_PNS[0])
    expect(g[3]![3]).toBe(10)
    expect(g[4]![0]).toBe('0900001-000')
    expect(g[5]![0]).toBe('Total')
    // 再导出：以上次输出为底，比价只剩 1 行 → 识别到表头行、多出的旧行清空
    const master2 = parseMasterWorkbook(readWorkbook(out.buffer), 'm2.xlsx')!
    const nego2 = negoSummaryFromInputs(master2, [{ pn: FIXTURE_PNS[0]!, qty: 10 }])
    const out2 = await buildMasterWorkbook(master2, out.buffer, { nego: nego2 })
    expect(out2.mode).toBe('patch')
    const g2 = parseMasterWorkbook(readWorkbook(out2.buffer), 'o2.xlsx')!.passthrough[0]!.grid
    expect(g2[2]![0]).toBe('P/N')
    expect(g2[3]![0]).toBe(FIXTURE_PNS[0])
    expect(g2[4]![0]).toBe('Total')
    expect((g2[5] ?? []).every((v) => v === null || String(v).trim() === '')).toBe(true) // 旧 Total 行整体清空
    expect(g2[3]![4]).toBe(56.7) // 只剩 HC 一家：仍按表头对齐落在 HC Unit 列
    expect(g2[3]![5]).toBeNull() // SKW Unit 列清空
    // 比价页为空 → NEGO sheet 原样不动
    const out3 = await buildMasterWorkbook(master2, out.buffer, { nego: negoSummaryFromInputs(master2, []) })
    expect(out3.negoRowsWritten).toBe(0)
  })

  it('NEGO sheet 表头在第 3 行、第 20 行有页脚：明细插在中间且 XML 行号保持升序、页脚不动', async () => {
    const base = new ExcelJS.Workbook()
    await base.xlsx.load(await makeMasterFile())
    const nws = base.getWorksheet('NEGO')!
    nws.getRow(3).values = ['P/N', 'Rev', 'Description', "Q'ty", 'HC Unit', 'SKW Unit', 'Min', 'HC Total', 'SKW Total', 'Optimal']
    nws.getCell('A20').value = 'footer'
    const original = (await base.xlsx.writeBuffer()) as ArrayBuffer
    const master = parseMasterWorkbook(readWorkbook(original), 'm.xlsx')!
    const nego = negoSummaryFromInputs(master, [
      { pn: FIXTURE_PNS[0]!, qty: 10 },
      { pn: '0900001-000', qty: 5 },
    ])
    const out = await buildMasterWorkbook(master, original, { nego })
    expect(out.mode).toBe('patch')
    const g = parseMasterWorkbook(readWorkbook(out.buffer), 'o.xlsx')!.passthrough[0]!.grid
    expect(g[2]![0]).toBe('P/N') // 用户表头原样
    expect(g[3]![0]).toBe(FIXTURE_PNS[0])
    expect(g[4]![0]).toBe('0900001-000')
    expect(g[5]![0]).toBe('Total')
    expect(g[19]![0]).toBe('footer')
    // sheetData 内 <row r> 必须升序（否则 Excel 报修复）
    const { unzipSync } = await import('fflate')
    const files = unzipSync(new Uint8Array(out.buffer))
    // 我们写入的格是内联字符串，按 Total 定位 NEGO sheet 的 XML（ExcelJS 写的原有文字走共享字符串表）
    const negoPath = Object.keys(files).find(
      (k) => /xl\/worksheets\/sheet\d+\.xml$/.test(k) && new TextDecoder().decode(files[k]!).includes('>Total</t>'),
    )!
    const rowNos = [...new TextDecoder().decode(files[negoPath]!).matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]))
    expect(rowNos).toEqual([...rowNos].sort((a, b) => a - b))
    expect(rowNos).toContain(4)
    expect(rowNos).toContain(20)
  })
})
