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
  let inheritedRows = 0
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
    const price =
      priceCol !== undefined
        ? parsePrice(grid[r]?.[priceCol], priceHeader, mapping.priceCurrency)
        : parsePrice(undefined, '', mapping.priceCurrency)
    const qtyRaw = cellStr(grid, r, colOf.qty)
    const qtyNum = qtyRaw !== '' && Number.isFinite(Number(qtyRaw)) ? Number(qtyRaw) : null
    // 阶梯报价省略行（HC 家写法）：第二数量档不写 P/N（"同上"）——
    // P/N 空 + 有数量 + 有效价 才算续行，继承上一条接受行；说明文字/合计行不满足仍拒收
    const prev = rows.length > 0 ? rows[rows.length - 1]! : null
    const isContinuation =
      pnRaw === '' &&
      prev !== null &&
      qtyNum !== null &&
      (price.status === 'ok' || price.status === 'pending')
    // 没有可用 P/N 的行无法参与比价，一律不要（同时干掉落在 P/N 列的说明文字）
    if (!isContinuation && (pnRaw === '' || /\s/.test(pnRaw))) {
      junk++
      consecutiveRejects++
      continue
    }
    const noRaw = cellStr(grid, r, colOf.no)
    const signals = [
      true, // pn 已通过硬校验（或续行继承）
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
    const inh = isContinuation ? prev : null
    const own = (field: FieldKey): string => cellStr(grid, r, colOf[field])
    if (isContinuation) inheritedRows++
    rows.push({
      pn: inh ? inh.pn : pnRaw,
      rev: own('rev').toUpperCase() || (inh?.rev ?? ''),
      qty: qtyNum,
      price,
      leadTime: parseLeadTime(colOf.leadTime !== undefined ? grid[r]?.[colOf.leadTime] : undefined),
      item: own('item'),
      quoteEa: own('quoteEa'),
      description: own('description') || (inh?.description ?? ''),
      material: own('material') || (inh?.material ?? ''),
      surfaceFinish: own('surfaceFinish') || (inh?.surfaceFinish ?? ''),
      cleaningSpec: own('cleaningSpec') || (inh?.cleaningSpec ?? ''),
      process: own('process') || (inh?.process ?? ''),
      size: own('size') || (inh?.size ?? ''),
      quoteNo: own('quoteNo'),
      remark: own('remark'),
      basePn: own('basePn') || (inh?.basePn ?? ''),
      partType: own('partType') || (inh?.partType ?? ''),
      sourceRow: r + 1,
    })
  }
  if (inheritedRows > 0)
    warnings.push(`${inheritedRows} 行省略零件号，已按上一行继承（阶梯报价常见写法）`)
  if (junk > 0) warnings.push(`已跳过 ${junk} 行非数据内容`)
  if (errorCells > 0)
    warnings.push(`发现 ${errorCells} 个公式错误单元格（如 #REF!），相应值按无效处理`)
  return { rows, warnings, junkRows: junk, errorCells }
}
