import { describe, expect, it } from 'vitest'
import type { MasterCell, MasterRow } from '@engine/index'
import {
  CELL_PAD,
  OVERSCAN,
  ROW_H,
  columnWidths,
  rowWindow,
  stickyLefts,
  type ColumnSpec,
} from '../../src/renderer/src/components/tableLayout'

describe('只画看得见的行', () => {
  it('表头处：从第一行画到屏幕下面再多 OVERSCAN 行', () => {
    // 790px 高能放 38 行，再多画 20 行，取整到 10 行
    expect(rowWindow(0, 790, ROW_H, 2599)).toEqual({ start: 0, end: 60 })
  })

  it('滚到中间：看得见的行上下都多画至少 OVERSCAN 行', () => {
    for (let top = 0; top < 2599 * ROW_H; top += 137) {
      const w = rowWindow(top, 790, ROW_H, 2599)
      const first = Math.floor(top / ROW_H)
      const last = Math.min(2599, Math.ceil((top + 790) / ROW_H))
      expect(w.start).toBeLessThanOrEqual(Math.max(0, first - OVERSCAN))
      expect(w.end).toBeGreaterThanOrEqual(Math.min(2599, last + OVERSCAN))
      expect(w.end - w.start).toBeLessThan(38 + 2 * OVERSCAN + 30) // 不会越画越多
    }
  })

  it('滚到底、行数少、滚动位置超出（筛选后行数变少）都不越界', () => {
    expect(rowWindow(2599 * ROW_H, 790, ROW_H, 2599).end).toBe(2599)
    expect(rowWindow(0, 790, ROW_H, 5)).toEqual({ start: 0, end: 5 })
    expect(rowWindow(50_000, 790, ROW_H, 5)).toEqual({ start: 5, end: 5 })
    expect(rowWindow(0, 790, ROW_H, 0)).toEqual({ start: 0, end: 0 })
  })

  it('滚一点点（不到 10 行）不换区间，免得每滚一下都重画', () => {
    const a = rowWindow(1000 * ROW_H, 790, ROW_H, 2599)
    const b = rowWindow(1000 * ROW_H + 3, 790, ROW_H, 2599)
    expect(b).toEqual(a)
  })
})

describe('列宽按全表内容固定', () => {
  const specs: ColumnSpec[] = [
    { min: 40, max: 64, header: 30 },
    { min: 100, max: 160, header: 120 },
    { min: 50, max: 80, header: 20 },
  ]
  const row = (...cells: MasterCell[]): MasterRow => ({ cells })
  const charW = (text: string) => text.length * 6

  it('最宽那格加内边距，夹在 [最窄, 最宽] 之间，且不比表头窄', () => {
    const rows = [row('1', 'abc', 'x'.repeat(5)), row('22', null, 'y'.repeat(7))]
    expect(columnWidths(rows, specs, charW, new WeakMap())).toEqual([
      40, // 内容 12 + 14 < 最窄 40
      120, // 没内容的列看表头
      Math.ceil(7 * 6 + CELL_PAD), // 56：在最窄和最宽之间
    ])
    const long = [row('x'.repeat(30), 'y'.repeat(100), null)]
    expect(columnWidths(long, specs, charW, new WeakMap())).toEqual([64, 160, 50])
  })

  it('按行缓存：改一格只重量那一行；太长的字直接按最宽算不量', () => {
    let calls = 0
    const counting = (text: string) => {
      calls++
      return charW(text)
    }
    const cache = new WeakMap<MasterRow, Float32Array>()
    const rows = [row('1', 'ab', 'cd'), row('2', 'ef', 'gh'), row('3', 'z'.repeat(500), 'ij')]
    columnWidths(rows, specs, counting, cache)
    expect(calls).toBe(8) // 第 3 行 B 列 500 个字超过最宽，不量
    calls = 0
    const edited = [rows[0]!, row('2', 'efg', 'gh'), rows[2]!]
    expect(columnWidths(edited, specs, counting, cache)).toEqual(columnWidths(edited, specs, charW, new WeakMap()))
    expect(calls).toBe(3) // 只有改过的那一行
  })

  it('冻结列左偏移 = 前面各列宽度之和', () => {
    expect(stickyLefts([55, 181, 71, 189, 46], 4)).toEqual([0, 55, 236, 307])
  })
})
