import { KK_COL } from '../export/kkLayout'
import { guessBatchLabel } from './merge'
import { isDataRow, type MasterCell, type MasterData } from './model'
import type { QuoteRow } from '../types'

/**
 * 同一批自动识别：同一批询价发给多家，只有部分家（HC）的回单带「询价 xxx」批次标签，
 * 另一些家（KV/凯阔）只有自家单号。靠 (P/N, 数量) 集合吻合把它们归到同一批：
 * 1) 自带标签（guessBatchLabel）；2) 与总表已并入行匹配取主导批次；
 * 3) 同时导入的其他文件带标签且零件集合重合 → 借用；4) 都没有 → 界面兜底今天日期。
 */

export interface BatchSuggestion {
  batch: string
  source: 'quote' | 'master' | 'sibling' | 'none'
  /** master 路径：与建议批次吻合的行数 / 报价总行数 */
  matched?: number
  total?: number
  /** sibling 路径：标签来源文件名 */
  siblingFile?: string
}

export interface BatchSibling {
  fileName: string
  rows: QuoteRow[]
}

const normPn = (v: MasterCell | string): string => String(v ?? '').trim().toUpperCase()

function numEq(a: MasterCell, b: number | null): boolean {
  if (b === null) return a === null || String(a).trim() === ''
  const n = Number(String(a ?? '').trim())
  return Number.isFinite(n) && n === b
}

/**
 * 报价行集与总表匹配出的主导批次：每条报价自底向上找最近的「同 P/N + 同数量」数据行
 * （不要求供应商槽位空——先到的家可能已填价），取匹配行 B 列的主导批次名。
 * 阈值：匹配行 ≥ 报价行的 50%，主导批次 ≥ 匹配行的 60%，批次名非空。
 */
export function suggestBatchFromMaster(
  master: MasterData,
  quotes: QuoteRow[],
): { batch: string; matched: number; total: number } | null {
  const total = quotes.length
  if (total === 0) return null
  const byLabel = new Map<string, { count: number; lastRow: number }>()
  let matchedRows = 0
  for (const q of quotes) {
    for (let i = master.rows.length - 1; i >= 0; i--) {
      const row = master.rows[i]!
      if (!isDataRow(row)) continue
      if (normPn(row.cells[KK_COL.pn]) !== normPn(q.pn)) continue
      if (!numEq(row.cells[KK_COL.qty] ?? null, q.qty)) continue
      matchedRows++
      const label = String(row.cells[KK_COL.name] ?? '').trim()
      if (label) {
        const e = byLabel.get(label)
        if (e) {
          e.count++
          if (i > e.lastRow) e.lastRow = i
        } else {
          byLabel.set(label, { count: 1, lastRow: i })
        }
      }
      break // 每条报价只认最近的一行
    }
  }
  if (matchedRows * 2 < total) return null
  let best: { label: string; count: number; lastRow: number } | null = null
  for (const [label, e] of byLabel) {
    if (!best || e.count > best.count || (e.count === best.count && e.lastRow > best.lastRow)) {
      best = { label, count: e.count, lastRow: e.lastRow }
    }
  }
  if (!best) return null
  if (best.count * 5 < matchedRows * 3) return null
  return { batch: best.label, matched: best.count, total }
}

/**
 * 两份报价的零件集合重合度：键 = P/N + 数量，返回 |交集| / min(|A|,|B|)
 * （containment——KV 常比询价多报几个阶梯数量档，用 min 不惩罚超集）。
 */
export function partSetOverlap(a: QuoteRow[], b: QuoteRow[]): number {
  const key = (q: QuoteRow) => `${normPn(q.pn)}|${q.qty ?? '?'}`
  const sa = new Set(a.map(key))
  const sb = new Set(b.map(key))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const k of sa) if (sb.has(k)) inter++
  return inter / Math.min(sa.size, sb.size)
}

const SIBLING_OVERLAP_MIN = 0.6

/** 批次建议链：自带标签 > 总表匹配 > 同批文件借标签 > 无 */
export function resolveBatchSuggestion(
  quotes: QuoteRow[],
  fileName: string,
  master: MasterData | null,
  siblings: BatchSibling[],
): BatchSuggestion {
  const own = guessBatchLabel(quotes, fileName)
  if (own) return { batch: own, source: 'quote' }
  if (master) {
    const m = suggestBatchFromMaster(master, quotes)
    if (m) return { batch: m.batch, source: 'master', matched: m.matched, total: m.total }
  }
  for (const sib of siblings) {
    const label = guessBatchLabel(sib.rows, sib.fileName)
    if (!label) continue
    if (partSetOverlap(quotes, sib.rows) >= SIBLING_OVERLAP_MIN) {
      return { batch: label, source: 'sibling', siblingFile: sib.fileName }
    }
  }
  return { batch: '', source: 'none' }
}
