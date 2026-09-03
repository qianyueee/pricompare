import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  KK_COL_COUNT,
  buildNegoLine,
  buildNegoSummary,
  buildNegoWorkbook,
  carryQtyFor,
  dedupeNegoLinesByPn,
  negoToTsv,
  planNegoSheetWrite,
  pnTiers,
  resolveNegoInput,
} from '@engine/index'
import type { MasterCell, MasterData, MasterRow } from '@engine/index'

function row(vals: Record<number, MasterCell>): MasterRow {
  const cells = Array.from({ length: KK_COL_COUNT }, () => null as MasterCell)
  for (const [k, v] of Object.entries(vals)) cells[Number(k)] = v
  return { cells }
}

const mkMaster = (rows: MasterRow[]): MasterData => ({
  rows,
  sheetName: 'KK询价汇总',
  passthrough: [],
  sourceFileName: null,
  importedAt: null,
})

describe('pnTiers 数量档', () => {
  // 列：1=批次 3=P/N 6=Q'ty 9=HC(J)
  const master = mkMaster([
    row({ 0: 1, 1: 'B1', 3: 'X-1', 6: 1, 9: 100 }),
    row({ 0: 2, 1: 'B1', 3: 'X-1', 6: 3, 9: 90 }),
    row({ 0: 3, 1: 'B2', 3: 'x-1 ', 6: 1, 9: 80 }), // 同数量再询（大小写/空格不同）
    row({ 0: 4, 1: 'B2', 3: 'OTHER', 6: 5, 9: 70 }),
    row({ 0: 5, 1: 'B3', 3: 'X-1', 9: 60 }), // 数量空 → null 档
    row({ 0: 6 }), // 预编号空行不参与
  ])

  it('归一化匹配、同数量取最近一行、按数量升序、空数量排最后', () => {
    const tiers = pnTiers(master, ' x-1')
    expect(tiers.map((t) => t.qty)).toEqual([1, 3, null])
    // qty=1 的两行取最靠下（更近）的 B2 行
    expect(tiers[0]).toMatchObject({ rowIndex: 2, excelRow: 4, batch: 'B2' })
    expect(tiers[1]).toMatchObject({ rowIndex: 1, batch: 'B1' })
  })

  it('查不到与空输入', () => {
    expect(pnTiers(master, 'NOPE')).toEqual([])
    expect(pnTiers(master, '  ')).toEqual([])
  })
})

describe('buildNegoLine 取行', () => {
  const master = mkMaster([
    row({ 3: 'P-1', 4: 'AA', 5: 'PLATE, FX', 6: 5, 8: 56.7, 9: '￥1,360.00', 10: 'TDB' }),
  ])

  it('槽位数值经金额清洗；TDB/空 → null；qty 可覆盖', () => {
    const line = buildNegoLine(master, 0)
    expect(line.pn).toBe('P-1')
    expect(line.rev).toBe('AA')
    expect(line.qty).toBe(5)
    expect(line.unit[8]).toBe(56.7)
    expect(line.unit[9]).toBe(1360) // 文本金额
    expect(line.unit[10]).toBeNull() // TDB
    expect(line.unit[11]).toBeNull() // 空槽
    expect(buildNegoLine(master, 0, 12).qty).toBe(12)
    expect(buildNegoLine(master, 0, null).qty).toBeNull()
  })
})

describe('buildNegoSummary 汇总', () => {
  const master = mkMaster([
    row({ 3: 'A-1', 6: 10, 9: 56.7, 10: 45 }),
    row({ 3: 'A-2', 6: 5, 9: 100 }), // SKW 缺报
  ])
  const summary = buildNegoSummary([buildNegoLine(master, 0), buildNegoLine(master, 1)])

  it('供应商 = 有报价的槽（按列序取表头名）', () => {
    expect(summary.vendors).toEqual([
      { slot: 9, label: 'HC' },
      { slot: 10, label: 'SKW' },
    ])
  })

  it('每行最低单价与总价（含浮点噪声消除）', () => {
    expect(summary.lines[0]).toMatchObject({
      minUnit: 45,
      totals: { 9: 567, 10: 450 }, // 56.7×10 精确为 567
      optimalTotal: 450,
    })
    expect(summary.lines[1]).toMatchObject({
      minUnit: 100,
      totals: { 9: 500, 10: null }, // 100×5
      optimalTotal: 500,
    })
  })

  it('各家合计（缺报行不计入并计数）与最优组合合计', () => {
    expect(summary.perVendor).toEqual([
      { slot: 9, label: 'HC', sum: 1067, missing: 0 }, // 567+500
      { slot: 10, label: 'SKW', sum: 450, missing: 1 },
    ])
    expect(summary.optimalSum).toBe(950) // 450+500
  })

  it('数量为空 → 各总价与最优为 null 并计缺', () => {
    const s = buildNegoSummary([buildNegoLine(master, 0, null)])
    expect(s.lines[0]!.totals[9]).toBeNull()
    expect(s.lines[0]!.optimalTotal).toBeNull()
    expect(s.perVendor.every((v) => v.missing === 1)).toBe(true)
    expect(s.optimalSum).toBe(0)
  })

  it('空面板', () => {
    const s = buildNegoSummary([])
    expect(s.vendors).toEqual([])
    expect(s.lines).toEqual([])
    expect(s.optimalSum).toBe(0)
  })
})

describe('resolveNegoInput 自由输入解析（比价页编号+数量格）', () => {
  const master = mkMaster([
    row({ 1: 'B1', 3: 'L-1', 6: 1, 9: 100 }),
    row({ 1: 'B1', 3: 'L-1', 6: 6, 9: 80 }),
    row({ 1: 'B1', 3: 'L-1', 6: 12, 9: 70 }),
  ])

  it('数量未填 → 只回档位列表（数量格 1/6/12 占位提示用），不出价', () => {
    const r = resolveNegoInput(master, 'L-1', null)
    expect(r.tiers.map((t) => t.qty)).toEqual([1, 6, 12])
    expect(r.usedTier).toBeNull()
    expect(r.line).toBeNull()
  })

  it('精确命中档位（编号大小写空格不敏感）', () => {
    const r = resolveNegoInput(master, ' l-1 ', 6)
    expect(r.usedTier?.qty).toBe(6)
    expect(r.line?.unit[9]).toBe(80)
    expect(r.line?.qty).toBe(6)
  })

  it('不在档上 → 阶梯语义取 ≤数量 的最大档，总价仍按输入数量', () => {
    const r = resolveNegoInput(master, 'L-1', 8)
    expect(r.usedTier?.qty).toBe(6)
    expect(r.line?.unit[9]).toBe(80)
    expect(r.line?.qty).toBe(8)
  })

  it('比最小档还小 → 取最小档；未找到编号 → 全空', () => {
    expect(resolveNegoInput(master, 'L-1', 0.5).usedTier?.qty).toBe(1)
    const miss = resolveNegoInput(master, 'NOPE', 5)
    expect(miss.tiers).toEqual([])
    expect(miss.usedTier).toBeNull()
    expect(miss.line).toBeNull()
  })
})

describe('buildNegoWorkbook 比价表导出（xlsx）', () => {
  it('NEGO 布局 + RMB 表头 + 数量在描述后 + 最低价绿高亮 + 合计行', async () => {
    const master = mkMaster([
      row({ 3: 'A-1', 6: 10, 9: 56.7, 10: 45 }),
      row({ 3: 'A-2', 6: 5, 9: 100 }),
    ])
    const summary = buildNegoSummary([buildNegoLine(master, 0), buildNegoLine(master, 1)])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await buildNegoWorkbook(summary))
    const ws = wb.getWorksheet('NEGO')!
    expect(ws.getRow(1).values).toEqual([
      undefined,
      'P/N',
      'Rev',
      'Description',
      "Q'ty",
      'HC Unit (RMB)',
      'SKW Unit (RMB)',
      'Min (RMB)',
      'HC Total (RMB)',
      'SKW Total (RMB)',
      'Optimal (RMB)',
    ])
    expect(ws.getCell('A2').value).toBe('A-1')
    expect(ws.getCell('D2').value).toBe(10) // 数量在描述后
    expect(ws.getCell('F2').value).toBe(45) // SKW 单价
    expect(ws.getCell('G2').value).toBe(45) // Min
    expect(ws.getCell('J2').value).toBe(450) // Optimal
    expect(ws.getCell('E3').value).toBe(100)
    // 合计行：各家总额 + 最优（表内全英文 → Total）
    expect(ws.getCell('A4').value).toBe('Total')
    expect(ws.getCell('H4').value).toBe(1067)
    expect(ws.getCell('I4').value).toBe(450)
    expect(ws.getCell('J4').value).toBe(950)
    // 本行最低单价绿色填充
    const fill = ws.getCell('F2').fill as { fgColor?: { argb?: string } }
    expect(fill?.fgColor?.argb).toBe('FFC6EFCE')
  })
})

describe('negoToTsv 剪贴板表格', () => {
  it('NEGO 同构布局：表头 / 行 / 合计行', () => {
    const master = mkMaster([
      row({ 3: 'A-1', 6: 10, 9: 56.7, 10: 45 }),
      row({ 3: 'A-2', 6: 5, 9: 100 }),
    ])
    const tsv = negoToTsv(buildNegoSummary([buildNegoLine(master, 0), buildNegoLine(master, 1)]))
    const lines = tsv.split('\n')
    expect(lines[0]).toBe("P/N\tRev\tDescription\tQ'ty\tHC Unit\tSKW Unit\tMin\tHC Total\tSKW Total\tOptimal")
    expect(lines[1]).toBe('A-1\t\t\t10\t56.7\t45\t45\t567\t450\t450')
    expect(lines[2]).toBe('A-2\t\t\t5\t100\t\t100\t500\t\t500')
    expect(lines[3]).toBe('Total\t\t\t\t\t\t\t1067\t450\t950')
  })
})

describe('比价页：同零件号合并与数量 Tab 继承', () => {
  it('dedupeNegoLinesByPn：同零件号只留先出现的一行（忽略大小写/空白），空行保留', () => {
    const out = dedupeNegoLinesByPn([
      { pn: 'A-1', qty: 3 },
      { pn: 'B-2', qty: null },
      { pn: ' a-1 ', qty: 9 },
      { pn: '', qty: null },
      { pn: 'B-2', qty: 5 },
      { pn: '', qty: null },
    ])
    expect(out).toEqual([
      { pn: 'A-1', qty: 3 },
      { pn: 'B-2', qty: null },
      { pn: '', qty: null },
      { pn: '', qty: null },
    ])
  })

  it('carryQtyFor：下一件在总表里恰有该数量档才继承，否则 null', () => {
    const master = mkMaster([
      row({ 3: 'L-1', 6: 1, 9: 10 }),
      row({ 3: 'L-1', 6: 6, 9: 8 }),
      row({ 3: 'M-1', 6: 3, 9: 5 }),
    ])
    expect(carryQtyFor(master, 'L-1', 6)).toBe(6)
    expect(carryQtyFor(master, 'L-1', 3)).toBeNull() // 无 3 档 → 留空手填
    expect(carryQtyFor(master, 'M-1', 3)).toBe(3)
    expect(carryQtyFor(master, 'NOPE', 3)).toBeNull()
    expect(carryQtyFor(master, 'L-1', null)).toBeNull()
  })
})

describe('导出时写入 NEGO sheet：planNegoSheetWrite', () => {
  const summaryOf = () => {
    const master = mkMaster([
      row({ 3: 'A-1', 6: 10, 9: 56.7, 10: 45 }),
      row({ 3: 'A-2', 6: 5, 9: 100 }),
    ])
    return buildNegoSummary([buildNegoLine(master, 0), buildNegoLine(master, 1)])
  }
  const HEAD: MasterCell[] = [null, 'P/N', 'Rev', 'Description', "Q'ty", 'HC Unit', 'SKW Unit', 'Min', 'HC Total', 'SKW Total', 'Optimal']

  it('找到用户表头行 → 明细从下一行起、对齐起始列；表头与一致的格不动；多出的旧行清空', () => {
    const grid: MasterCell[][] = [
      [null, 'Basis For Negotiation'],
      [],
      HEAD,
      [null, 'OLD-1', 'AA', 'old', 1, 10, 20, 10, 10, 20, 10],
      [null, 'OLD-2', 'AA', 'old', 2, 5, null, 5, 10, null, 10],
      [null, 'OLD-3', 'AA', 'old', 3, 5, null, 5, 15, null, 15],
      [null, 'Total', null, null, null, null, null, null, 35, 20, 35],
    ]
    const plan = planNegoSheetWrite(grid, summaryOf())
    expect(plan.headerFound).toBe(true)
    expect(plan.startRow).toBe(2)
    expect(plan.startCol).toBe(1)
    expect(plan.lineCount).toBe(2)
    expect(plan.writes.has(2)).toBe(false) // 用户自己的表头行不改
    expect(plan.writes.get(3)!.get(1)).toBe('A-1')
    expect(plan.writes.get(3)!.get(4)).toBe(10)
    expect(plan.writes.get(3)!.get(5)).toBe(56.7)
    expect(plan.writes.get(4)!.get(1)).toBe('A-2')
    // 第 3 条明细位置改成 Total 行：'Total' 与合计写入，空列清空
    expect(plan.writes.get(5)!.get(1)).toBe('Total')
    expect(plan.writes.get(5)!.get(8)).toBe(1067)
    expect(plan.writes.get(5)!.get(9)).toBe(450)
    expect(plan.writes.get(5)!.get(10)).toBe(950)
    expect(plan.writes.get(5)!.get(2)).toBeNull() // 旧 'AA' 清空
    // 原 Total 行（第 6 行）整体清空
    expect(plan.writes.get(6)!.get(1)).toBeNull()
    expect(plan.writes.get(6)!.get(8)).toBeNull()
  })

  it('没有表头行（如只有标题）→ 从标题下方第 3 行起连表头一起写', () => {
    const grid: MasterCell[][] = [[null, 'Basis For Negotiation'], ['marker']]
    const plan = planNegoSheetWrite(grid, summaryOf())
    expect(plan.headerFound).toBe(false)
    expect(plan.startRow).toBe(2)
    expect(plan.startCol).toBe(0)
    expect(plan.writes.get(2)!.get(0)).toBe('P/N')
    expect(plan.writes.get(2)!.get(3)).toBe("Q'ty")
    expect(plan.writes.get(3)!.get(0)).toBe('A-1')
    expect(plan.writes.get(5)!.get(0)).toBe('Total')
    expect(plan.writes.has(0)).toBe(false) // 标题区不动
  })

  it('按表头文字对齐列：只剩 HC 一家时数据仍落在 HC 列、SKW 列清空；表头没有的列追加并补表头', () => {
    const master = mkMaster([row({ 3: 'A-1', 6: 10, 9: 56.7 })])
    const hcOnly = buildNegoSummary([buildNegoLine(master, 0)]) // vendors = [HC]
    const grid: MasterCell[][] = [
      [null, 'Basis For Negotiation'],
      [],
      [null, 'P/N', 'Rev', 'Description', 'Qty', 'HC Unit (RMB)', 'SKW Unit', 'Min', 'HC Total', 'SKW Total', 'Optimal'],
      [null, 'OLD-1', 'AA', 'old', 1, 10, 20, 10, 10, 20, 10],
      [null, 'Total', null, null, null, null, null, null, 10, 20, 10],
    ]
    const plan = planNegoSheetWrite(grid, hcOnly)
    expect(plan.headerFound).toBe(true)
    const r3 = plan.writes.get(3)!
    expect(r3.get(1)).toBe('A-1')
    expect(r3.get(4)).toBe(10) // Qty ≈ Q'ty
    expect(r3.get(5)).toBe(56.7) // HC Unit (RMB) ≈ HC Unit
    expect(r3.get(6)).toBeNull() // SKW Unit 清空
    expect(r3.get(7)).toBe(56.7) // Min
    expect(r3.get(8)).toBe(567) // HC Total
    expect(r3.get(9)).toBeNull() // SKW Total 清空
    expect(r3.get(10)).toBe(567) // Optimal
    expect(plan.writes.get(4)!.get(8)).toBe(567) // Total 行 HC 合计
    expect(plan.writes.has(2)).toBe(false) // 表头行未改
    // 表头里没有 SKW 列时：追加在末尾并写表头文字
    const master2 = mkMaster([row({ 3: 'B-1', 6: 2, 9: 10, 10: 8 })])
    const both = buildNegoSummary([buildNegoLine(master2, 0)])
    const grid2: MasterCell[][] = [[null, 'P/N', 'Rev', 'Description', "Q'ty", 'HC Unit', 'Min', 'HC Total', 'Optimal']]
    const plan2 = planNegoSheetWrite(grid2, both)
    expect(plan2.writes.get(0)!.get(9)).toBe('SKW Unit')
    expect(plan2.writes.get(0)!.get(10)).toBe('SKW Total')
    expect(plan2.writes.get(1)!.get(9)).toBe(8)
    expect(plan2.writes.get(1)!.get(5)).toBe(10)
    expect(plan2.writes.get(1)!.get(6)).toBe(8) // Min
    expect(plan2.writes.get(1)!.get(10)).toBe(16) // SKW Total 2×8
  })
})
