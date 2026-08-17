import { describe, expect, it } from 'vitest'
import { KK_COL_COUNT, clearMasterCells, deleteMasterRows } from '@engine/index'
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

describe('deleteMasterRows 删除整行', () => {
  const master = mkMaster([
    row({ 0: 1, 3: 'P-1', 6: 1 }),
    row({ 0: 2, 3: 'P-2', 6: 1 }),
    row({ 0: 3, 3: 'P-3', 6: 1 }),
    row({ 0: 4 }), // 预编号空行
    row({ 0: 5 }),
  ])

  it('删中间行：后续行上移、A 序号重排（占位行顺延）、不改原对象', () => {
    const next = deleteMasterRows(master, [1])
    expect(next.rows).toHaveLength(4)
    expect(next.rows.map((r) => r.cells[3])).toEqual(['P-1', 'P-3', null, null])
    expect(next.rows.map((r) => r.cells[0])).toEqual([1, 2, 3, 4])
    expect(master.rows).toHaveLength(5) // 不可变
    expect(master.rows[3]!.cells[0]).toBe(4)
  })

  it('删多行 + 非数字 A 原样保留、重排跳过', () => {
    const m2 = mkMaster([
      row({ 0: 1, 3: 'X' }),
      row({ 0: 'a', 3: 'Y' }),
      row({ 0: 2, 3: 'Z' }),
      row({ 0: 3, 3: 'W' }),
    ])
    const next = deleteMasterRows(m2, [0, 3])
    expect(next.rows.map((r) => r.cells[3])).toEqual(['Y', 'Z'])
    expect(next.rows.map((r) => r.cells[0])).toEqual(['a', 1])
  })
})

describe('clearMasterCells 清空单元格', () => {
  it('置空所选、A 列保护、越界行列安全忽略、不可变', () => {
    const master = mkMaster([row({ 0: 1, 3: 'P-1', 9: 100, 10: 90 })])
    const next = clearMasterCells(master, [
      { rowIndex: 0, cols: [0, 9, 10, 99] },
      { rowIndex: 5, cols: [3] },
    ])
    expect(next.rows[0]!.cells[0]).toBe(1) // A 序号不清
    expect(next.rows[0]!.cells[9]).toBeNull()
    expect(next.rows[0]!.cells[10]).toBeNull()
    expect(next.rows[0]!.cells[3]).toBe('P-1')
    expect(master.rows[0]!.cells[9]).toBe(100) // 不可变
  })

  it('全部目标无效 → 返回原引用（界面免持久化）', () => {
    const master = mkMaster([row({ 0: 1, 3: 'P-1' })])
    expect(clearMasterCells(master, [{ rowIndex: 9, cols: [3] }])).toBe(master)
    expect(clearMasterCells(master, [{ rowIndex: 0, cols: [0] }])).toBe(master)
  })
})
