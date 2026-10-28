import { describe, expect, it } from 'vitest'
import { KK_COL, KK_COL_COUNT, applyMasterOp, planMerge } from '@engine/index'
import type { MasterCell, MasterData, MasterOp, MasterRow } from '@engine/index'
import { averageQuoteEach, nextQuoteEach, recalcQuoteEachChanges } from '../../src/engine/master/quoteEach'
import { makeQuote } from '../fixtures/rows'

const H = KK_COL.quoteEach
const [MAO, HC, SKW, CL, BY, JM] = [8, 9, 10, 11, 12, 13]
const YJ = KK_COL.yj

function row(vals: Record<number, MasterCell>): MasterRow {
  const cells = Array.from({ length: KK_COL_COUNT }, () => null as MasterCell)
  for (const [k, v] of Object.entries(vals)) cells[Number(k)] = v
  return { cells }
}

const mkMaster = (rows: MasterRow[]): MasterData => ({
  rows,
  sheetName: 'KK询价汇总',
  passthrough: [],
  sourceFileName: 'KK询价汇总表.xlsm',
  importedAt: 1,
})

function roundTrip(master: MasterData, op: MasterOp) {
  const r = applyMasterOp(master, op)
  expect(r.inverse).not.toBeNull()
  expect(applyMasterOp(r.master, r.inverse!).master.rows).toEqual(master.rows)
  return r
}

describe('H 列 = 各家报价平均，向上取整到个位（Zane 2026-10-28）', () => {
  it('七家供应商列（I–N、AG）里的数字都算，平均后向上取整', () => {
    expect(averageQuoteEach(row({ [HC]: 453.4, [SKW]: 1000 }).cells)).toBe(727) // 726.7
    expect(averageQuoteEach(row({ [HC]: 1813.4, [SKW]: 5200, [CL]: 3000 }).cells)).toBe(3338) // 3337.8
    expect(averageQuoteEach(row({ [MAO]: 10, [BY]: 20, [JM]: 30, [YJ]: 41 }).cells)).toBe(26) // 25.25
    expect(averageQuoteEach(row({ [SKW]: 1020 }).cells)).toBe(1020) // 整数不进位
    expect(averageQuoteEach(row({ [HC]: 0.1, [SKW]: 0.2 }).cells)).toBe(1)
    expect(averageQuoteEach(row({ [HC]: 100.1, [SKW]: 100.2, [CL]: 100.3 }).cells)).toBe(101) // 100.2 不因浮点误差进到 102
  })

  it('文字（TDB、无、US$ 美元价、说明）和 0 不算；一个数字价都没有 → null', () => {
    expect(averageQuoteEach(row({ [HC]: 'US$50', [SKW]: 800 }).cells)).toBe(800)
    expect(averageQuoteEach(row({ [HC]: '无', [SKW]: 'TDB', [YJ]: 350 }).cells)).toBe(350)
    expect(averageQuoteEach(row({ [HC]: 0, [SKW]: 500 }).cells)).toBe(500)
    expect(averageQuoteEach(row({ [HC]: 'TDB' }).cells)).toBeNull()
    expect(averageQuoteEach(row({ [H]: 999, [KK_COL.usVendor]: 50 }).cells)).toBeNull() // H、O 不是供应商列
  })

  it('报价全清掉：H 原来是自动平均价才清空，手填的和文字说明留着', () => {
    const before = row({ [HC]: 100, [SKW]: 201, [H]: 151 }).cells
    expect(nextQuoteEach(before, row({ [H]: 151 }).cells)).toBeNull()
    expect(nextQuoteEach(row({ [HC]: 100, [H]: 120 }).cells, row({ [H]: 120 }).cells)).toBeUndefined()
    expect(nextQuoteEach(row({ [HC]: 100, [H]: '总价850' }).cells, row({ [H]: '总价850' }).cells)).toBeUndefined()
  })
})

describe('改供应商价时 H 自动重算', () => {
  const base = () =>
    mkMaster([
      row({ 0: 1, 1: 'B', 3: 'P-1', 6: 10, [HC]: 100, [SKW]: 300, [H]: 300 }), // 老行：H 是凯维价
      row({ 0: 2, 1: 'B', 3: 'P-2', 6: 5, [H]: '总价850约100张' }),
    ])

  it('改了供应商价 → H 按平均重算；撤销回到原来的 H（哪怕原来不是平均价）', () => {
    const r = roundTrip(base(), { kind: 'setCells', cells: [{ row: 0, col: HC, value: 151 }] })
    expect(r.master.rows[0]!.cells[H]).toBe(226) // (151 + 300) / 2 = 225.5
    expect(r.changedCells).toBe(2)
  })

  it('平均价正好等于原 H：H 不动，撤销后也不被改成别的', () => {
    const r = roundTrip(base(), { kind: 'setCells', cells: [{ row: 0, col: HC, value: 300 }] })
    expect(r.master.rows[0]!.cells[H]).toBe(300)
    expect(r.changedCells).toBe(1)
  })

  it('同一次也写了 H（手改）→ 按写的值，不重算', () => {
    const r = roundTrip(base(), {
      kind: 'setCells',
      cells: [
        { row: 0, col: HC, value: 151 },
        { row: 0, col: H, value: 280 },
      ],
    })
    expect(r.master.rows[0]!.cells[H]).toBe(280)
  })

  it('只改别的列（备注、H 本身）不碰 H', () => {
    const r = applyMasterOp(base(), { kind: 'setCells', cells: [{ row: 0, col: KK_COL.comment, value: 'x' }] })
    expect(r.master.rows[0]!.cells[H]).toBe(300)
    const h = applyMasterOp(base(), { kind: 'setCells', cells: [{ row: 0, col: H, value: 999 }] })
    expect(h.master.rows[0]!.cells[H]).toBe(999)
  })

  it('文字说明的 H：有了数字报价就换成平均价；报价是文字时不动', () => {
    const r = roundTrip(base(), { kind: 'setCells', cells: [{ row: 1, col: HC, value: 700 }] })
    expect(r.master.rows[1]!.cells[H]).toBe(700)
    const t = applyMasterOp(base(), { kind: 'setCells', cells: [{ row: 1, col: HC, value: '无' }] })
    expect(t.master.rows[1]!.cells[H]).toBe('总价850约100张')
  })

  it('清空供应商价（Delete）：剩下的重算，全清掉时自动算的 H 一起清空', () => {
    const m = mkMaster([row({ 0: 1, 3: 'P-1', 6: 1, [HC]: 100, [SKW]: 201, [H]: 151 })])
    const one = roundTrip(m, { kind: 'setCells', cells: [{ row: 0, col: SKW, value: null }] })
    expect(one.master.rows[0]!.cells[H]).toBe(100)
    const all = roundTrip(m, {
      kind: 'setCells',
      cells: [
        { row: 0, col: HC, value: null },
        { row: 0, col: SKW, value: null },
      ],
    })
    expect(all.master.rows[0]!.cells[H]).toBeNull()
  })

  it('并入：每并入一家 H 重算；撤销并入回到原表', () => {
    const m = base()
    const op: MasterOp = {
      kind: 'merge',
      quotes: [makeQuote('P-1', { rev: '', qty: 10, amount: 251 }), makeQuote('P-9', { rev: '', qty: 1, amount: 45.2 })],
      options: { batch: 'B', vendorSlot: CL, vendorId: 'cl', vendorDisplay: 'CL' },
    }
    const r = roundTrip(m, op)
    expect(r.master.rows[0]!.cells[H]).toBe(217) // (100 + 300 + 251) / 3 = 217
    expect(r.master.rows[2]!.cells[H]).toBe(46) // 新增行只有一家：45.2 → 46
    // 平均价正好等于原 H 的情况：撤销也写回原 H
    const same = roundTrip(m, { ...op, quotes: [makeQuote('P-1', { rev: '', qty: 10, amount: 500 })] })
    expect(same.master.rows[0]!.cells[H]).toBe(300)
  })

  it('并入 TDB / 没识别到价格：H 不动', () => {
    const m = base()
    const plan = planMerge(m, [makeQuote('P-1', { rev: '', qty: 10, pending: true })], {
      batch: 'B',
      vendorSlot: CL,
      vendorId: 'cl',
      vendorDisplay: 'CL',
    })
    expect(plan.actions[0]!.changes.some((c) => c.col === H)).toBe(false)
  })
})

describe('整表补算 H（recalc-h）', () => {
  const rows = [
    row({ [HC]: 100, [SKW]: 201 }), // 空着 → 151
    row({ [HC]: 100, [SKW]: 300, [H]: 300 }), // 已有数字 → 全部重算才改
    row({ [HC]: 100, [H]: 'TDB' }), // 占位当空
    row({ [HC]: 100, [H]: '总价850约100张' }), // 文字说明不动
    row({ [HC]: 'US$50' }), // 没有数字报价
    row({ [SKW]: 88, [H]: 88 }), // 已经是平均价
  ]

  it('--only-empty 只补空着的和 TDB 占位', () => {
    expect(recalcQuoteEachChanges(rows, true)).toEqual([
      { row: 0, from: null, to: 151 },
      { row: 2, from: 'TDB', to: 100 },
    ])
  })

  it('全部：已有的数字 H 也换成平均价，文字说明照旧不动', () => {
    expect(recalcQuoteEachChanges(rows, false)).toEqual([
      { row: 0, from: null, to: 151 },
      { row: 1, from: 300, to: 200 },
      { row: 2, from: 'TDB', to: 100 },
    ])
  })
})
