import { parseLeadTime } from './normalize/leadtime'
import { parsePrice } from './normalize/price'
import type { ColumnMapping, FieldKey, Grid, QuoteRow } from './types'

/** 宏说明等垃圾行关键词（KV 样本数据区下方有 "Macro shortcut" / "Ctl+A Show all rows"） */
const BLACKLIST_RE = /macro|shortcut|ctl\s*\+|ctrl\s*\+/i
const MAX_DATA_ROWS = 3000
/**
 * 连续被拒该行数即认为数据结束：既要挡住带格式拖到几百行的空尾巴，
 * 也要容忍汇总类表里批次之间成段的空行分隔。
 */
const STOP_AFTER_REJECTS = 30

export interface ExtractResult {
  rows: QuoteRow[]
  warnings: string[]
  junkRows: number
  errorCells: number
}

function cellStr(grid: Grid, r: number, c: number | undefined): string {
  if (c === undefined) return ''
  const cell = grid[r]?.[c]
  if (!cell || cell.v === null) return ''
  return String(cell.v).trim()
}

export function extractRows(
  grid: Grid,
  mapping: ColumnMapping,
  headerTexts: Record<number, string>,
): ExtractResult {
  const colOf: Partial<Record<FieldKey, number>> = {}
  for (const [cStr, f] of Object.entries(mapping.map)) {
    if (f !== 'ignore' && colOf[f] === undefined) colOf[f] = Number(cStr)
  }
  const priceCol = mapping.priceCol >= 0 ? mapping.priceCol : colOf.price
  const priceHeader = priceCol !== undefined ? (headerTexts[priceCol] ?? '') : ''

  const rows: QuoteRow[] = []
  const warnings: string[] = []
  let junk = 0
  let errorCells = 0
  let consecutiveRejects = 0
  const end = Math.min(grid.length, mapping.headerRow + 1 + MAX_DATA_ROWS)

  for (let r = mapping.headerRow + 1; r < end; r++) {
    if (consecutiveRejects >= STOP_AFTER_REJECTS) break
    const line = grid[r]
    const isEmpty =
      !line || line.every((c) => !c || c.v === null || String(c.v).trim() === '')
    if (isEmpty) {
      consecutiveRejects++
      continue
    }
    let blacklisted = false
    for (const cell of line) {
      if (cell?.isError) errorCells++
      if (cell && typeof cell.v === 'string' && BLACKLIST_RE.test(cell.v)) blacklisted = true
    }
    if (blacklisted) {
      junk++
      consecutiveRejects++
      continue
    }
    const pnRaw = cellStr(grid, r, colOf.pn)
    // 没有可用 P/N 的行无法参与比价，一律不要（同时干掉落在 P/N 列的说明文字）
    if (pnRaw === '' || /\s/.test(pnRaw)) {
      junk++
      consecutiveRejects++
      continue
    }
    const price =
      priceCol !== undefined
        ? parsePrice(grid[r]?.[priceCol], priceHeader, mapping.priceCurrency)
        : parsePrice(undefined, '', mapping.priceCurrency)
    const qtyRaw = cellStr(grid, r, colOf.qty)
    const qtyNum = qtyRaw !== '' && Number.isFinite(Number(qtyRaw)) ? Number(qtyRaw) : null
    const noRaw = cellStr(grid, r, colOf.no)
    const signals = [
      true, // pn 已通过硬校验
      noRaw !== '' && Number.isFinite(Number(noRaw)),
      qtyNum !== null,
      price.status === 'ok' || price.status === 'pending',
    ].filter(Boolean).length
    if (signals < 2) {
      junk++
      consecutiveRejects++
      continue
    }
    consecutiveRejects = 0
    rows.push({
      pn: pnRaw,
      rev: cellStr(grid, r, colOf.rev).toUpperCase(),
      qty: qtyNum,
      price,
      leadTime: parseLeadTime(colOf.leadTime !== undefined ? grid[r]?.[colOf.leadTime] : undefined),
      item: cellStr(grid, r, colOf.item),
      quoteEa: cellStr(grid, r, colOf.quoteEa),
      description: cellStr(grid, r, colOf.description),
      material: cellStr(grid, r, colOf.material),
      surfaceFinish: cellStr(grid, r, colOf.surfaceFinish),
      cleaningSpec: cellStr(grid, r, colOf.cleaningSpec),
      process: cellStr(grid, r, colOf.process),
      size: cellStr(grid, r, colOf.size),
      quoteNo: cellStr(grid, r, colOf.quoteNo),
      remark: cellStr(grid, r, colOf.remark),
      basePn: cellStr(grid, r, colOf.basePn),
      partType: cellStr(grid, r, colOf.partType),
      sourceRow: r + 1,
    })
  }
  if (junk > 0) warnings.push(`已跳过 ${junk} 行非数据内容`)
  if (errorCells > 0)
    warnings.push(`发现 ${errorCells} 个公式错误单元格（如 #REF!），相应值按无效处理`)
  return { rows, warnings, junkRows: junk, errorCells }
}
