import type {
  CompareCell,
  CompareResult,
  CompareRow,
  QuoteRow,
  VendorQuotes,
} from './types'

const KEY_SEP = '␟'

export function rowKey(row: QuoteRow): string {
  return [row.pn, row.rev, row.qty ?? '?'].join(KEY_SEP)
}

/** 人民币等值单价；非 ok 报价为 null */
function rmbEquivalent(row: QuoteRow, usdRate: number): number | null {
  if (row.price.status !== 'ok' || row.price.amount === undefined) return null
  return row.price.currency === 'USD' ? row.price.amount * usdRate : row.price.amount
}

/**
 * 构建比价矩阵：按 P/N + Rev + 数量档位对齐各家报价。
 * 仅 status=ok 的价参与最低价判定；只有一家有效报价的行不标最低（标"仅一家"）。
 */
export function buildCompare(vendorQuotes: VendorQuotes[], usdRate: number): CompareResult {
  const warnings: string[] = []
  const vendors = vendorQuotes.map((v) => ({ vendorId: v.vendorId, vendorDisplay: v.vendorDisplay }))
  const rowMap = new Map<string, CompareRow>()

  for (const vq of vendorQuotes) {
    for (const q of vq.rows) {
      const key = rowKey(q)
      let row = rowMap.get(key)
      if (!row) {
        row = {
          key,
          pn: q.pn,
          rev: q.rev,
          qty: q.qty,
          description: '',
          cells: {},
          minRmb: null,
          okCount: 0,
          singleQuote: false,
        }
        rowMap.set(key, row)
      }
      if (row.cells[vq.vendorId]) {
        warnings.push(
          `${vq.vendorDisplay} 对 ${q.pn}（数量 ${q.qty ?? '—'}）重复报价，取文件中靠后的一行`,
        )
      }
      const cell: CompareCell = {
        price: q.price,
        rmbEquivalent: rmbEquivalent(q, usdRate),
        leadTime: q.leadTime,
        deltaPct: null,
        isMin: false,
        source: q,
      }
      row.cells[vq.vendorId] = cell
    }
  }

  const rows = [...rowMap.values()].sort(
    (a, b) =>
      a.pn.localeCompare(b.pn) ||
      (a.qty ?? Number.MAX_SAFE_INTEGER) - (b.qty ?? Number.MAX_SAFE_INTEGER) ||
      a.rev.localeCompare(b.rev),
  )

  for (const row of rows) {
    const okCells = Object.values(row.cells).filter(
      (c): c is CompareCell => !!c && c.rmbEquivalent !== null,
    )
    row.okCount = okCells.length
    row.singleQuote = okCells.length === 1
    if (okCells.length > 0) {
      row.minRmb = Math.min(...okCells.map((c) => c.rmbEquivalent!))
    }
    // 描述等取最低价供应商的行，缺则任一非空
    let descSource: QuoteRow | undefined
    for (const c of Object.values(row.cells)) {
      if (!c) continue
      if (c.rmbEquivalent !== null && c.rmbEquivalent === row.minRmb && !descSource) descSource = c.source
    }
    if (!descSource || !descSource.description) {
      for (const c of Object.values(row.cells)) {
        if (c?.source.description) {
          if (!descSource || !descSource.description) descSource = c.source
        }
      }
    }
    row.description = descSource?.description ?? ''
    for (const c of Object.values(row.cells)) {
      if (!c || c.rmbEquivalent === null || row.minRmb === null) continue
      if (okCells.length >= 2) {
        c.isMin = c.rmbEquivalent === row.minRmb
        c.deltaPct = row.minRmb > 0 ? (c.rmbEquivalent - row.minRmb) / row.minRmb : null
      }
    }
  }

  const perVendor = vendorQuotes.map((vq) => {
    let quotedRows = 0
    let sumUnit = 0
    let sumExtended = 0
    let extendedRows = 0
    for (const row of rows) {
      const c = row.cells[vq.vendorId]
      if (!c || c.rmbEquivalent === null) continue
      quotedRows++
      sumUnit += c.rmbEquivalent
      if (row.qty !== null) {
        sumExtended += c.rmbEquivalent * row.qty
        extendedRows++
      }
    }
    return {
      vendorId: vq.vendorId,
      quotedRows,
      missingRows: rows.length - quotedRows,
      sumUnit,
      sumExtended,
      extendedRows,
    }
  })

  let bestUnitSum = 0
  let bestExtendedSum = 0
  let comparableRows = 0
  for (const row of rows) {
    if (row.minRmb === null) continue
    comparableRows++
    bestUnitSum += row.minRmb
    if (row.qty !== null) bestExtendedSum += row.minRmb * row.qty
  }

  return {
    vendors,
    rows,
    totals: { perVendor, bestUnitSum, bestExtendedSum, comparableRows },
    warnings: [...new Set(warnings)],
  }
}
