import { MIN_AUTO_HEADER_SCORE, detectHeader, scoreHeaderRow } from './headerDetect'
import { rankPriceCandidates } from './priceColumn'
import type { ColumnMapping, Currency, FieldKey, Grid, PriceCandidate } from './types'
import type { Vendor } from './vendor'

export interface AutoMapResult {
  headerRow: number
  headerScore: number
  needsManualHeader: boolean
  mapping: ColumnMapping
  candidates: PriceCandidate[]
}

/** 自动列映射：表头检测 → 字段去重（同字段多列保最高置信）→ 单价列排名 */
export function autoMap(grid: Grid, vendors: Vendor[], forcedHeaderRow?: number): AutoMapResult {
  const best =
    forcedHeaderRow !== undefined
      ? scoreHeaderRow(grid, forcedHeaderRow)
      : (detectHeader(grid)[0] ?? { row: 0, score: 0, fields: {} })
  const needsManualHeader = forcedHeaderRow === undefined && best.score < MIN_AUTO_HEADER_SCORE

  const map: Record<number, FieldKey> = {}
  const confidence: Record<number, number> = {}
  const byField = new Map<FieldKey, { col: number; confidence: number }>()
  for (const [cStr, m] of Object.entries(best.fields)) {
    const c = Number(cStr)
    confidence[c] = m.confidence
    if (m.field === 'ignore') continue
    // 价格列允许多列并存（真实样本里 H "Quote(each)" 常为空、真价在别的列），由候选排名裁决
    if (m.field === 'price') {
      map[c] = 'price'
      continue
    }
    const prev = byField.get(m.field)
    if (!prev || m.confidence > prev.confidence) byField.set(m.field, { col: c, confidence: m.confidence })
  }
  for (const [field, { col }] of byField) map[col] = field

  const candidates = rankPriceCandidates(grid, best.row, map, vendors)
  const priceCol = candidates.length > 0 ? candidates[0]!.col : -1
  const priceCurrency: Currency = candidates.length > 0 ? candidates[0]!.currencyGuess : 'RMB'
  // price 同义词命中但未被选中的列从映射中移除，避免提取歧义
  for (const [cStr, f] of Object.entries(map)) {
    if (f === 'price' && Number(cStr) !== priceCol) delete map[Number(cStr)]
  }
  if (priceCol >= 0) map[priceCol] = 'price'

  return {
    headerRow: best.row,
    headerScore: best.score,
    needsManualHeader,
    mapping: { headerRow: best.row, map, priceCol, priceCurrency, confidence },
    candidates,
  }
}
