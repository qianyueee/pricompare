import { CANONICAL_LAYOUT, type MasterCell, type MasterData, type MasterLayout } from './model'

/**
 * 金额/数量数据清洗：历史汇总里混有文本格式的数字（'9000'、'￥1,133.40'、
 * '$935.00 '（尾带 nbsp）、'1'），统一修正为真正的数字。
 * 备注类文字（"没有图纸"、"做不了"、"无"、"/"）原样保留。
 */

/** 参与清洗的列：数量 + 选定价 + 各供应商价 + US Vendor/USD + 成本分项 + 对客报价（序号、单号等绝不触碰） */
export function amountCols(layout: MasterLayout): number[] {
  return [
    layout.qty,
    layout.quoteEach,
    ...layout.vendorSlots.map((s) => s.col),
    layout.usVendor,
    layout.usd,
    ...layout.costCols,
    layout.quoteEa,
  ].filter((c) => c >= 0)
}

/** 模板原样布局下的清洗列（G + H..U） */
export const AMOUNT_COLS: readonly number[] = amountCols(CANONICAL_LAYOUT)

const STRIP_RE = /[\uffe5\u00a5$\u20ac,\uff0c\s\u00a0\u2000-\u200b\u3000]/g

/** 文本金额 → 数字；转不了（备注文字/空串/TDB 等）返回 null */
export function cleanAmountString(s: string): number | null {
  const cleaned = s.replace(STRIP_RE, '')
  if (cleaned === '') return null
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

export interface CleanResult {
  master: MasterData
  /** 被修正的单元格数 */
  changed: number
}

/** 全表清洗（不修改入参）：只动金额/数量列里能安全转数字的文本单元格 */
export function cleanMasterAmounts(master: MasterData): CleanResult {
  let changed = 0
  const cols = amountCols(master.layout)
  const rows = master.rows.map((row) => {
    let cells: MasterCell[] | null = null
    for (const c of cols) {
      const v = row.cells[c]
      if (typeof v !== 'string') continue
      const n = cleanAmountString(v)
      if (n === null) continue
      if (!cells) cells = [...row.cells]
      cells[c] = n
      changed++
    }
    return cells ? { cells } : row
  })
  return { master: changed > 0 ? { ...master, rows } : master, changed }
}
