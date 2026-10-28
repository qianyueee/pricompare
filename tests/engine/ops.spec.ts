import { describe, expect, it } from 'vitest'
import { KK_COL_COUNT, applyMasterOp, describeMasterOp, opShiftsRows } from '@engine/index'
import type { MasterCell, MasterData, MasterOp, MasterRow } from '@engine/index'
import { makeQuote } from '../fixtures/rows'

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

const base = () =>
  mkMaster([
    row({ 0: 1, 1: '20261001 A', 3: 'P-1', 6: 10, 9: 100 }),
    row({ 0: 2, 1: '20261001 A', 3: 'P-2', 6: 5, 10: 80 }),
    row({ 0: 3, 1: '20261002 B', 3: 'P-3', 6: 1 }),
    row({ 0: 4 }), // 预编号空行
  ])

/** 应用操作再应用它的反向操作，应回到原表 */
function roundTrip(master: MasterData, op: MasterOp) {
  const r = applyMasterOp(master, op)
  expect(r.inverse).not.toBeNull()
  const back = applyMasterOp(r.master, r.inverse!)
  expect(back.master.rows).toEqual(master.rows)
  return r
}

describe('applyMasterOp 总表操作', () => {
  it('setCells：只改动到的行换新对象，原表不变，反向操作还原', () => {
    const m = base()
    const r = roundTrip(m, {
      kind: 'setCells',
      cells: [
        { row: 0, col: 9, value: 120 },
        { row: 0, col: 22, value: '3 weeks' },
        { row: 2, col: 11, value: 66 },
      ],
    })
    expect(r.changedCells).toBe(5) // 3 格 + 两行的 H 跟着重算
    expect(r.master.rows[0]!.cells[9]).toBe(120)
    expect(r.master.rows[0]!.cells[7]).toBe(120)
    expect(r.master.rows[2]!.cells[11]).toBe(66)
    expect(r.master.rows[2]!.cells[7]).toBe(66)
    expect(r.master.rows[1]).toBe(m.rows[1]) // 未改的行共用引用
    expect(m.rows[0]!.cells[9]).toBe(100)
  })

  it('setCells：同一格写两次，反向操作回到最早的值', () => {
    const m = base()
    roundTrip(m, {
      kind: 'setCells',
      cells: [
        { row: 1, col: 10, value: 1 },
        { row: 1, col: 10, value: 2 },
      ],
    })
  })

  it('setCells：值没变或越界列 → 无改动、无反向操作', () => {
    const m = base()
    const r = applyMasterOp(m, {
      kind: 'setCells',
      cells: [
        { row: 0, col: 9, value: 100 },
        { row: 0, col: KK_COL_COUNT, value: 1 },
        { row: 99, col: 3, value: null },
      ],
    })
    expect(r.inverse).toBeNull()
    expect(r.changedCells).toBe(0)
    expect(r.master).toBe(m)
  })

  it('deleteRows → restoreRows：A 列序号重排后又原样恢复', () => {
    const m = base()
    const r = roundTrip(m, { kind: 'deleteRows', rows: [2, 0, 0] })
    expect(r.master.rows.map((x) => x.cells[3])).toEqual(['P-2', null])
    expect(r.master.rows.map((x) => x.cells[0])).toEqual([1, 2])
    expect(r.inverse).toEqual({
      kind: 'restoreRows',
      rows: [
        { index: 0, cells: m.rows[0]!.cells },
        { index: 2, cells: m.rows[2]!.cells },
      ],
    })
  })

  it('restoreRows 下标超出表长 → 接在表尾，反向删的是实际插入的位置', () => {
    const m = mkMaster([row({ 0: 1, 3: 'A' })])
    const r = applyMasterOp(m, {
      kind: 'restoreRows',
      rows: [
        { index: 5, cells: row({ 0: 9, 3: 'B' }).cells },
        { index: 8, cells: row({ 0: 9, 3: 'C' }).cells },
      ],
    })
    expect(r.master.rows.map((x) => x.cells[3])).toEqual(['A', 'B', 'C'])
    expect(r.master.rows.map((x) => x.cells[0])).toEqual([1, 2, 3])
    expect(r.inverse).toEqual({ kind: 'deleteRows', rows: [1, 2] })
    expect(applyMasterOp(r.master, r.inverse!).master.rows).toEqual(m.rows)
  })

  it('merge：规则与桌面版并入相同，撤销还原改过的格并删掉追加的尾行', () => {
    const m = base()
    const op: MasterOp = {
      kind: 'merge',
      quotes: [
        makeQuote('P-3', { rev: '', qty: 1, amount: 55, lead: '2 weeks' }),
        makeQuote('P-9', { rev: '', qty: 2, amount: 7 }),
        makeQuote('P-10', { rev: '', qty: 3, amount: 8 }),
      ],
      options: { batch: '20261002 B', vendorSlot: 11, vendorId: 'cl', vendorDisplay: 'CL' },
    }
    const r = roundTrip(m, op)
    expect(r.merge).toMatchObject({ fill: 1, append: 2 })
    expect(r.master.rows[2]!.cells[11]).toBe(55)
    expect(r.master.rows.length).toBeGreaterThan(m.rows.length)
    expect(opShiftsRows(op)).toBe(false)
    expect(opShiftsRows(r.inverse!)).toBe(true) // 撤销并入会删行
  })

  it('merge：重复并入同一份报价 → 全部跳过，表不变', () => {
    const m = base()
    const op: MasterOp = {
      kind: 'merge',
      quotes: [makeQuote('P-3', { rev: '', qty: 1, amount: 55 })],
      options: { batch: '20261002 B', vendorSlot: 11, vendorId: 'cl', vendorDisplay: 'CL' },
    }
    const once = applyMasterOp(m, op)
    const twice = applyMasterOp(once.master, op)
    expect(twice.merge?.skip).toBe(1)
    expect(twice.inverse).toBeNull()
    expect(twice.master).toBe(once.master)
  })

  it('batch：按顺序应用，反向操作倒序', () => {
    const m = base()
    roundTrip(m, {
      kind: 'batch',
      ops: [
        { kind: 'setCells', cells: [{ row: 1, col: 10, value: 81 }] },
        { kind: 'deleteRows', rows: [0] },
        { kind: 'setCells', cells: [{ row: 0, col: 10, value: 82 }] },
      ],
    })
  })

  it('replace：整表替换，不可撤销', () => {
    const m = base()
    const next = mkMaster([row({ 0: 1, 3: 'X' })])
    const r = applyMasterOp(m, { kind: 'replace', master: next })
    expect(r.master).toBe(next)
    expect(r.inverse).toBeNull()
  })

  it('操作可经 JSON 往返（服务端存历史、网页端发请求）', () => {
    const m = base()
    const op: MasterOp = {
      kind: 'merge',
      quotes: [makeQuote('P-1', { rev: '', qty: 10, amount: 90 })],
      options: { batch: '20261001 A', vendorSlot: 10, vendorId: 'skw', vendorDisplay: 'SKW' },
    }
    const a = applyMasterOp(m, op)
    const b = applyMasterOp(m, JSON.parse(JSON.stringify(op)) as MasterOp)
    expect(b.master).toEqual(a.master)
    expect(describeMasterOp(op)).toBe('并入 SKW 报价 1 条（批次 20261001 A）')
  })
})
