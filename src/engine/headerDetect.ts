import { matchField } from './synonyms'
import { parsePrice } from './normalize/price'
import type { FieldKey, Grid } from './types'

/** 关键字段命中权重更高：有它们才像一张报价表的表头 */
const KEY_WEIGHT: Partial<Record<FieldKey, number>> = {
  pn: 2,
  qty: 2,
  price: 2,
  description: 2,
  leadTime: 2,
}

/** 低于该分数认为自动识别不可靠，映射界面进入手动选表头行模式 */
export const MIN_AUTO_HEADER_SCORE = 4

export interface HeaderCandidate {
  row: number
  score: number
  fields: Record<number, { field: FieldKey; confidence: number }>
}

export function scoreHeaderRow(grid: Grid, row: number): HeaderCandidate {
  const cells = grid[row] ?? []
  let score = 0
  let textCount = 0
  let numCount = 0
  const fields: HeaderCandidate['fields'] = {}
  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c]
    if (!cell || cell.v === null) continue
    if (typeof cell.v === 'number') {
      numCount++
      continue
    }
    const s = String(cell.v).trim()
    if (!s) continue
    textCount++
    const m = matchField(s)
    if (m.field !== 'ignore' && m.confidence > 0) {
      fields[c] = m
      score += (KEY_WEIGHT[m.field] ?? 1) * m.confidence
    }
  }
  // 表头应是文字行；数字多于文字的多半是数据行
  if (numCount > textCount) score *= 0.3
  // 奖励：判定为 price/qty 的列，下方 3 行内出现了数字或货币文本
  const numericCols = Object.entries(fields)
    .filter(([, m]) => m.field === 'price' || m.field === 'qty')
    .map(([c]) => Number(c))
  outer: for (const c of numericCols) {
    for (let r = row + 1; r <= Math.min(row + 3, grid.length - 1); r++) {
      const cell = grid[r]?.[c]
      if (!cell || cell.v === null) continue
      if (typeof cell.v === 'number' || parsePrice(cell, '', 'RMB').status === 'ok') {
        score += 2
        break outer
      }
    }
  }
  return { row, score, fields }
}

/** 扫描前 scanRows 行，按得分降序返回表头候选 */
export function detectHeader(grid: Grid, scanRows = 10): HeaderCandidate[] {
  const out: HeaderCandidate[] = []
  for (let r = 0; r < Math.min(scanRows, grid.length); r++) out.push(scoreHeaderRow(grid, r))
  return out.sort((a, b) => b.score - a.score || a.row - b.row)
}
