import { KK_COL, KK_VENDOR_SLOT_HEADERS } from '../export/kkLayout'
import { cleanAmountString } from './clean'
import { isDataRow, type MasterCell, type MasterData } from './model'

/**
 * NEGO 谈判比价（参照用户汇总表的 NEGO sheet）：
 * 选定若干行（零件×数量档），并排各家单价、最低单价、按下单数量算各家总额与最优组合总额，
 * 用于谈"全给某家 vs 最优拆分"的差价。
 */

const VENDOR_SLOTS = [8, 9, 10, 11, 12, 13] as const

const normPn = (v: MasterCell | string): string => String(v ?? '').trim().toUpperCase()

function cellNum(v: MasterCell | undefined): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  return cleanAmountString(v)
}

function cellStr(v: MasterCell | undefined): string {
  return v === null || v === undefined ? '' : String(v)
}

/** 金额乘积消除二进制浮点噪声（56.7×10 → 567 而非 567.000…01） */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6

export interface PnTier {
  qty: number | null
  rowIndex: number
  excelRow: number
  batch: string
}

/**
 * 某 P/N 在总表里的有效数量档：同一数量多次询价取最靠下（最近）一行；按数量升序。
 * 供界面显示 "几/几/几" 提示。
 */
export function pnTiers(master: MasterData, pn: string): PnTier[] {
  const target = normPn(pn)
  if (!target) return []
  const byQty = new Map<string, PnTier>()
  master.rows.forEach((row, rowIndex) => {
    if (!isDataRow(row)) return
    if (normPn(row.cells[KK_COL.pn]) !== target) return
    const qty = cellNum(row.cells[KK_COL.qty])
    const key = qty === null ? '?' : String(qty)
    // 靠后的行覆盖靠前的（最近一次询价优先）
    byQty.set(key, { qty, rowIndex, excelRow: rowIndex + 2, batch: cellStr(row.cells[KK_COL.name]) })
  })
  return [...byQty.values()].sort((a, b) => (a.qty ?? Infinity) - (b.qty ?? Infinity))
}

export interface NegoLine {
  rowIndex: number
  pn: string
  rev: string
  description: string
  /** 下单数量（可与来源档位不同，总价按它算） */
  qty: number | null
  /** 各供应商槽位（8..13）的单价；TDB/文字/空 → null */
  unit: Record<number, number | null>
}

export function buildNegoLine(master: MasterData, rowIndex: number, qtyOverride?: number | null): NegoLine {
  const row = master.rows[rowIndex]
  const cells = row?.cells ?? []
  const unit: Record<number, number | null> = {}
  for (const slot of VENDOR_SLOTS) unit[slot] = cellNum(cells[slot])
  return {
    rowIndex,
    pn: cellStr(cells[KK_COL.pn]),
    rev: cellStr(cells[KK_COL.rev]),
    description: cellStr(cells[KK_COL.description]),
    qty: qtyOverride !== undefined ? qtyOverride : cellNum(cells[KK_COL.qty]),
    unit,
  }
}

export interface PnResolution {
  /** 该 P/N 在总表的全部数量档（空数组 = 未找到） */
  tiers: PnTier[]
  /** 实际取价的档位（qty 未填或未找到 → null） */
  usedTier: PnTier | null
  /** 解析出的比价行（总价按输入 qty 计算）；无法取价 → null */
  line: NegoLine | null
}

/**
 * 比价页自由输入解析：给定 P/N 与下单数量，找到取价档位。
 * qty 精确命中某档 → 该档；否则按阶梯语义取 ≤qty 的最大档；比最小档还小 → 最小档；
 * qty 未填 → 只返回档位列表（界面在数量格中以 "1/3/6" 占位提示）。
 */
export function resolveNegoInput(master: MasterData, pn: string, qty: number | null): PnResolution {
  const tiers = pnTiers(master, pn)
  if (tiers.length === 0) return { tiers, usedTier: null, line: null }
  if (qty === null) return { tiers, usedTier: null, line: null }
  const numeric = tiers.filter((t): t is PnTier & { qty: number } => t.qty !== null)
  let used: PnTier | null = numeric.find((t) => t.qty === qty) ?? null
  if (!used && numeric.length > 0) {
    const below = numeric.filter((t) => t.qty <= qty)
    used = below.length > 0 ? below[below.length - 1]! : numeric[0]!
  }
  if (!used) used = tiers[0]! // 只有数量为空（'?'）的档
  return { tiers, usedTier: used, line: buildNegoLine(master, used.rowIndex, qty) }
}

export interface NegoVendor {
  slot: number
  label: string
}

export interface NegoSummaryLine extends NegoLine {
  minUnit: number | null
  /** slot → 总价（单价×数量；缺单价或缺数量 → null） */
  totals: Record<number, number | null>
  optimalTotal: number | null
}

export interface NegoSummary {
  vendors: NegoVendor[]
  lines: NegoSummaryLine[]
  perVendor: { slot: number; label: string; sum: number; missing: number }[]
  optimalSum: number
}

export function buildNegoSummary(lines: NegoLine[]): NegoSummary {
  const usedSlots = VENDOR_SLOTS.filter((slot) => lines.some((l) => l.unit[slot] !== null))
  const vendors: NegoVendor[] = usedSlots.map((slot) => ({
    slot,
    label: KK_VENDOR_SLOT_HEADERS[slot - 8]!,
  }))
  const summaryLines: NegoSummaryLine[] = lines.map((l) => {
    const present = usedSlots.map((s) => l.unit[s]).filter((u): u is number => u !== null)
    const minUnit = present.length > 0 ? Math.min(...present) : null
    const totals: Record<number, number | null> = {}
    for (const slot of usedSlots) {
      const u = l.unit[slot]
      totals[slot] = u !== null && l.qty !== null ? round6(u * l.qty) : null
    }
    const optimalTotal = minUnit !== null && l.qty !== null ? round6(minUnit * l.qty) : null
    return { ...l, minUnit, totals, optimalTotal }
  })
  const perVendor = vendors.map(({ slot, label }) => {
    let sum = 0
    let missing = 0
    for (const l of summaryLines) {
      const t = l.totals[slot]
      if (t === null || t === undefined) missing++
      else sum += t
    }
    return { slot, label, sum: round6(sum), missing }
  })
  const optimalSum = round6(summaryLines.reduce((s, l) => s + (l.optimalTotal ?? 0), 0))
  return { vendors, lines: summaryLines, perVendor, optimalSum }
}

/** NEGO sheet 同构布局的 TSV（可直接粘贴进 Excel） */
export function negoToTsv(summary: NegoSummary): string {
  const head = [
    'P/N',
    'Rev',
    'Description',
    "Q'ty",
    ...summary.vendors.map((v) => `${v.label} Unit`),
    'Min',
    ...summary.vendors.map((v) => `${v.label} Total`),
    'Optimal',
  ]
  const rows = summary.lines.map((l) => [
    l.pn,
    l.rev,
    l.description,
    l.qty ?? '',
    ...summary.vendors.map((v) => l.unit[v.slot] ?? ''),
    l.minUnit ?? '',
    ...summary.vendors.map((v) => l.totals[v.slot] ?? ''),
    l.optimalTotal ?? '',
  ])
  const totalRow = [
    '合计',
    '',
    '',
    '',
    ...summary.vendors.map(() => ''),
    '',
    ...summary.perVendor.map((v) => v.sum),
    summary.optimalSum,
  ]
  return [head, ...rows, totalRow].map((r) => r.join('\t')).join('\n')
}
