import { describe, expect, it } from 'vitest'
import { makeQuote } from '../fixtures/rows'
import {
  KK_COL_COUNT,
  partSetOverlap,
  resolveBatchSuggestion,
  suggestBatchFromMaster,
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

// 列：1=批次(B) 3=P/N(D) 6=数量(G) 9=HC(J)
const master = mkMaster([
  row({ 0: 1, 1: 'Old', 3: 'P-1', 6: 1, 9: 80 }), // 同 P/N+数量的旧批次行
  row({ 0: 2, 1: 'New', 3: 'P-1', 6: 1, 9: 565 }),
  row({ 0: 3, 1: 'New', 3: 'P-2', 6: 1, 9: 452 }),
  row({ 0: 4 }), // 预编号空行不参与
])

describe('suggestBatchFromMaster 总表匹配', () => {
  it('每条报价取最近匹配行，主导批次胜出（旧批次同件不干扰）', () => {
    const s = suggestBatchFromMaster(master, [makeQuote('P-1', { qty: 1 }), makeQuote('P-2', { qty: 1 })])
    expect(s).toEqual({ batch: 'New', matched: 2, total: 2 })
  })

  it('部分匹配 ≥50% 仍建议；全不匹配/数量不符 → null', () => {
    const s = suggestBatchFromMaster(master, [makeQuote('P-1', { qty: 1 }), makeQuote('P-9', { qty: 1 })])
    expect(s).toEqual({ batch: 'New', matched: 1, total: 2 })
    expect(suggestBatchFromMaster(master, [makeQuote('P-9', { qty: 1 })])).toBeNull()
    expect(suggestBatchFromMaster(master, [makeQuote('P-1', { qty: 5 })])).toBeNull()
  })

  it('匹配行批次五五开（无主导 ≥60%）→ null', () => {
    const m = mkMaster([
      row({ 0: 1, 1: 'A', 3: 'P-1', 6: 1 }),
      row({ 0: 2, 1: 'B', 3: 'P-2', 6: 1 }),
    ])
    expect(suggestBatchFromMaster(m, [makeQuote('P-1', { qty: 1 }), makeQuote('P-2', { qty: 1 })])).toBeNull()
  })
})

describe('partSetOverlap 零件集合重合度', () => {
  const two = [makeQuote('P-1', { qty: 1 }), makeQuote('P-2', { qty: 1 })]
  it('同集=1；超集 containment=1；数量不同/不相交=0', () => {
    expect(partSetOverlap(two, [...two])).toBe(1)
    // KV 多报一个阶梯档：仍视为同一批
    expect(partSetOverlap(two, [...two, makeQuote('P-1', { qty: 5 })])).toBe(1)
    expect(partSetOverlap(two, [makeQuote('P-1', { qty: 9 }), makeQuote('P-9', { qty: 1 })])).toBe(0)
    expect(partSetOverlap([], two)).toBe(0)
  })
})

describe('resolveBatchSuggestion 建议链', () => {
  const kvQuotes = [makeQuote('P-1', { qty: 1, quoteNo: 'KV202608151' }), makeQuote('P-2', { qty: 1, quoteNo: 'KV202608151' })]
  const hcSibling = {
    fileName: 'HCQuote20260814.xlsx',
    rows: [
      makeQuote('P-1', { qty: 1, quoteNo: '询价 20260814 Natalie A' }),
      makeQuote('P-2', { qty: 1, quoteNo: '询价 20260814 Natalie A' }),
    ],
  }

  it('自带「询价」标签最优先（quote）', () => {
    expect(resolveBatchSuggestion(hcSibling.rows, hcSibling.fileName, master, [])).toEqual({
      batch: '20260814 Natalie A',
      source: 'quote',
    })
  })

  it('无标签 → 总表匹配（master）', () => {
    expect(resolveBatchSuggestion(kvQuotes, 'KV202608152_Kaikwo0815A.xlsx', master, [hcSibling])).toEqual({
      batch: 'New',
      source: 'master',
      matched: 2,
      total: 2,
    })
  })

  it('无标签、总表无匹配 → 借同批文件标签（sibling）', () => {
    expect(resolveBatchSuggestion(kvQuotes, 'KV202608152.xlsx', null, [hcSibling])).toEqual({
      batch: '20260814 Natalie A',
      source: 'sibling',
      siblingFile: 'HCQuote20260814.xlsx',
    })
    // 集合不重合的文件不借
    const other = { fileName: 'HCQuote.xlsx', rows: [makeQuote('X-1', { qty: 3, quoteNo: '询价 20260101 Z' })] }
    expect(resolveBatchSuggestion(kvQuotes, 'KV202608152.xlsx', null, [other])).toEqual({
      batch: '',
      source: 'none',
    })
  })
})
