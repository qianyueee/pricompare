import { normalizeHeader } from './synonyms'
import { parsePrice } from './normalize/price'
import type { Currency, FieldKey, Grid, PriceCandidate } from './types'
import type { Vendor } from './vendor'

/**
 * 衍生列惩罚：换算价（USD）、成本、运费、对客报价（Quote (EA)）、单号等
 * 都不是供应商报出的单价，即使数值密度高也要压下去。
 */
const DERIVED_RE =
  /usd|cost|total|总价|金额|shipping|freight|运费|快递|tariff|关税|clean|quote\(ea\)|quote#|quoteno|序号|^no\.?$/

/** 探测数据行：表头下方 P/N 列非空且不含空格的行（供数值密度统计） */
export function probeDataRows(
  grid: Grid,
  headerRow: number,
  pnCol: number | undefined,
  limit = 200,
): number[] {
  const rows: number[] = []
  if (pnCol === undefined) return rows
  const end = Math.min(grid.length, headerRow + 1 + limit)
  for (let r = headerRow + 1; r < end; r++) {
    const cell = grid[r]?.[pnCol]
    if (!cell || cell.v === null) continue
    const s = String(cell.v).trim()
    if (!s || /\s/.test(s)) continue
    rows.push(r)
  }
  return rows
}

/**
 * 单价列候选排名。
 * 候选来源：price 同义词列 ∪ 表头命中供应商别名的列（SKW/HC/Mao…）∪ 数值密度 ≥ 0.6 的未映射列。
 * 得分 = 3·price同义词 + 2·供应商表头 + 数值密度 + 0.5·人民币线索 − 2·衍生列。
 */
export function rankPriceCandidates(
  grid: Grid,
  headerRow: number,
  map: Record<number, FieldKey>,
  vendors: Vendor[],
): PriceCandidate[] {
  const headerCells = grid[headerRow] ?? []
  const pnEntry = Object.entries(map).find(([, f]) => f === 'pn')
  const pnCol = pnEntry ? Number(pnEntry[0]) : undefined
  const dataRows = probeDataRows(grid, headerRow, pnCol)
  const aliasSet = new Set(
    vendors.flatMap((v) => [...v.aliases, v.id, v.display].map((a) => normalizeHeader(a))),
  )
  const out: PriceCandidate[] = []
  for (let c = 0; c < headerCells.length; c++) {
    const headerCell = headerCells[c]
    const headerRaw = headerCell && headerCell.v !== null ? String(headerCell.v) : ''
    const n = normalizeHeader(headerRaw)
    const mapped = map[c]
    if (mapped && mapped !== 'price' && mapped !== 'ignore') continue
    const isPriceSyn = mapped === 'price'
    const isVendorHeader = n !== '' && aliasSet.has(n)
    let numeric = 0
    const samples: string[] = []
    for (const r of dataRows) {
      const p = parsePrice(grid[r]?.[c], headerRaw, 'RMB')
      if (p.status === 'ok') {
        numeric++
        if (samples.length < 3 && p.raw && !samples.includes(p.raw)) samples.push(p.raw)
      } else if (p.status === 'pending' && samples.length < 3 && !samples.includes(p.raw)) {
        samples.push(p.raw)
      }
    }
    const density = dataRows.length > 0 ? numeric / dataRows.length : 0
    if (!isPriceSyn && !isVendorHeader) {
      if (n === '' || density < 0.6 || DERIVED_RE.test(n)) continue
    }
    if (numeric === 0 && !isPriceSyn) continue
    let score = (isPriceSyn ? 3 : 0) + (isVendorHeader ? 2 : 0) + density
    // "Quote (each)" 一族是模板约定的单价列，有值时永远优先于供应商别名列
    if (numeric > 0 && /^quote\(?each/.test(n)) score += 1.5
    if (/rmb|￥|人民币/.test(n)) score += 0.5
    if (DERIVED_RE.test(n)) score -= 2
    // 一整列都没有有效数值的"单价"表头（模板留空列）要输给真正填了价的列
    if (numeric === 0 && dataRows.length > 0) score -= 1.5
    const currencyGuess: Currency = /us\$|usd|美元|美金/.test(n) ? 'USD' : 'RMB'
    out.push({
      col: c,
      header: headerRaw,
      score,
      numericCount: numeric,
      rowCount: dataRows.length,
      sampleValues: samples,
      currencyGuess,
    })
  }
  return out.sort((a, b) => b.score - a.score || a.col - b.col)
}
