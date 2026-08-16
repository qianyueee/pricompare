import { describe, expect, it } from 'vitest'
import {
  KK_COL_COUNT,
  buildNegoLine,
  buildNegoSummary,
  negoToTsv,
  pnTiers,
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
    expect(lines[3]).toBe('合计\t\t\t\t\t\t\t1067\t450\t950')
  })
})
