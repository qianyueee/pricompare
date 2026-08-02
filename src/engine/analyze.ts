import { autoMap } from './columnMap'
import { detectHeader } from './headerDetect'
import { extractRows } from './extractRows'
import { sheetFingerprint } from './fingerprint'
import { rankPriceCandidates } from './priceColumn'
import { guessVendor, type Vendor } from './vendor'
import { sheetGrid, type ParsedWorkbook } from './workbook'
import type { AnalyzedSheet, ColumnMapping, Grid } from './types'

export interface AnalyzeOptions {
  fileName: string
  vendors: Vendor[]
  /** 指定 sheet；缺省自动选表头得分最高的 */
  sheetName?: string
  /** 用户在预览里手动指定的表头行（0 基） */
  forcedHeaderRow?: number
  /** 用户确认过或模板套用的映射：跳过自动识别，直接按它提取 */
  mappingOverride?: ColumnMapping
}

/** 多 sheet 时选表头得分最高的（只扫每个 sheet 的前 40 行） */
export function pickBestSheet(pw: ParsedWorkbook): { sheetName: string; score: number } {
  let best = { sheetName: pw.sheetNames[0] ?? '', score: -1 }
  for (const name of pw.sheetNames) {
    const grid = sheetGrid(pw, name, 40)
    const score = detectHeader(grid)[0]?.score ?? 0
    if (score > best.score) best = { sheetName: name, score }
  }
  return best
}

function collectColumnValues(grid: Grid, headerRow: number, col: number | undefined, limit = 20): string[] {
  if (col === undefined) return []
  const out: string[] = []
  for (let r = headerRow + 1; r < grid.length && out.length < limit; r++) {
    const cell = grid[r]?.[col]
    if (!cell || cell.v === null) continue
    const s = String(cell.v).trim()
    if (s) out.push(s)
  }
  return [...new Set(out)]
}

export async function analyzeSheet(pw: ParsedWorkbook, opts: AnalyzeOptions): Promise<AnalyzedSheet> {
  const sheetName = opts.sheetName ?? pickBestSheet(pw).sheetName
  const grid = sheetGrid(pw, sheetName)

  let mapping: ColumnMapping
  let headerScore = 0
  let needsManualHeader = false
  let candidates
  if (opts.mappingOverride) {
    mapping = opts.mappingOverride
    candidates = rankPriceCandidates(grid, mapping.headerRow, mapping.map, opts.vendors)
  } else {
    const auto = autoMap(grid, opts.vendors, opts.forcedHeaderRow)
    mapping = auto.mapping
    headerScore = auto.headerScore
    needsManualHeader = auto.needsManualHeader
    candidates = auto.candidates
  }

  const headerCells = grid[mapping.headerRow] ?? []
  const headerTexts: Record<number, string> = {}
  headerCells.forEach((cell, c) => {
    if (cell && cell.v !== null) headerTexts[c] = String(cell.v)
  })

  const { rows, warnings } = extractRows(grid, mapping, headerTexts)
  if (needsManualHeader) warnings.unshift('未能可靠识别表头行，请在预览中确认')

  const fingerprint = await sheetFingerprint(sheetName, grid, mapping.headerRow)

  const nameEntry = Object.entries(mapping.map).find(([, f]) => f === 'name')
  const vendorGuess = guessVendor(opts.vendors, {
    fileName: opts.fileName,
    quoteNos: [...new Set(rows.map((r) => r.quoteNo).filter(Boolean))],
    nameValues: collectColumnValues(grid, mapping.headerRow, nameEntry ? Number(nameEntry[0]) : undefined),
    priceHeader: mapping.priceCol >= 0 ? (headerTexts[mapping.priceCol] ?? '') : '',
  })

  const previewRows = Math.min(grid.length, Math.max(15, mapping.headerRow + 9))
  const preview = grid.slice(0, previewRows)
  const columnCount = preview.reduce((m, row) => Math.max(m, row?.length ?? 0), 0)

  return {
    sheetName,
    headerRow: mapping.headerRow,
    headerScore,
    needsManualHeader,
    mapping,
    candidates,
    fingerprint,
    vendorGuess,
    rows,
    warnings,
    preview,
    columnCount,
  }
}
