import { cleanAmountString } from './clean'
import { CANONICAL_LAYOUT, isDataRow, type MasterCell, type MasterData, type VendorSlot } from './model'

/**
 * NEGO 谈判比价（参照用户汇总表的 NEGO sheet）：
 * 选定若干行（零件×数量档），并排各家单价、最低单价、按下单数量算各家总额与最优组合总额，
 * 用于谈"全给某家 vs 最优拆分"的差价。
 */

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
  const L = master.layout
  const byQty = new Map<string, PnTier>()
  master.rows.forEach((row, rowIndex) => {
    if (!isDataRow(row)) return
    if (normPn(row.cells[L.pn]) !== target) return
    const qty = cellNum(row.cells[L.qty])
    const key = qty === null ? '?' : String(qty)
    // 靠后的行覆盖靠前的（最近一次询价优先）
    byQty.set(key, { qty, rowIndex, excelRow: rowIndex + 2, batch: cellStr(row.cells[L.name]) })
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
  /** 各供应商价格列（物理列号 → 单价）；TDB/文字/空 → null */
  unit: Record<number, number | null>
}

export function buildNegoLine(master: MasterData, rowIndex: number, qtyOverride?: number | null): NegoLine {
  const L = master.layout
  const row = master.rows[rowIndex]
  const cells = row?.cells ?? []
  const unit: Record<number, number | null> = {}
  for (const slot of L.vendorSlots) unit[slot.col] = cellNum(cells[slot.col])
  return {
    rowIndex,
    pn: cellStr(cells[L.pn]),
    rev: cellStr(cells[L.rev]),
    description: cellStr(cells[L.description]),
    qty: qtyOverride !== undefined ? qtyOverride : cellNum(cells[L.qty]),
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

/**
 * 比价页行按零件号合并：同一零件号（忽略大小写/首尾空白）只保留先出现的一行（含其数量），
 * 后面的重复丢弃；零件号为空的行（末尾空行 / 正在输入）原样保留。
 * 粘贴一列、Ctrl+B 选行、手输提交三条入口共用。
 */
export function dedupeNegoLinesByPn<T extends { pn: string; qty: number | null }>(lines: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const l of lines) {
    const key = normPn(l.pn)
    if (key === '') {
      out.push(l)
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    out.push(l)
  }
  return out
}

/**
 * 数量 Tab 继承：上一行输入数量后按 Tab，下一行该零件在总表里**恰有**这个数量档才继承，
 * 否则返回 null（留空让用户手填）。
 */
export function carryQtyFor(master: MasterData, pn: string, carry: number | null): number | null {
  if (carry === null) return null
  return pnTiers(master, pn).some((t) => t.qty === carry) ? carry : null
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

/** @param slots 汇总表的供应商列（默认模板 I–N）；只保留出现过报价的家 */
export function buildNegoSummary(lines: NegoLine[], slots: readonly VendorSlot[] = CANONICAL_LAYOUT.vendorSlots): NegoSummary {
  const vendors: NegoVendor[] = slots
    .filter((s) => lines.some((l) => l.unit[s.col] !== null && l.unit[s.col] !== undefined))
    .map((s) => ({ slot: s.col, label: s.label }))
  const usedSlots = vendors.map((v) => v.slot)
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

/** NEGO sheet 同构表格（表头 / 明细 / Total 合计行）：「复制为表格」与导出时写入 NEGO sheet 共用 */
export function negoTable(summary: NegoSummary): MasterCell[][] {
  const head: MasterCell[] = [
    'P/N',
    'Rev',
    'Description',
    "Q'ty",
    ...summary.vendors.map((v) => `${v.label} Unit`),
    'Min',
    ...summary.vendors.map((v) => `${v.label} Total`),
    'Optimal',
  ]
  const rows: MasterCell[][] = summary.lines.map((l) => [
    l.pn,
    l.rev,
    l.description,
    l.qty,
    ...summary.vendors.map((v) => l.unit[v.slot] ?? null),
    l.minUnit,
    ...summary.vendors.map((v) => l.totals[v.slot] ?? null),
    l.optimalTotal,
  ])
  const totalRow: MasterCell[] = [
    'Total', // 粘贴目标 NEGO sheet 为英文表，合计行不用中文
    null,
    null,
    null,
    ...summary.vendors.map(() => null),
    null,
    ...summary.perVendor.map((v) => v.sum),
    summary.optimalSum,
  ]
  return [head, ...rows, totalRow]
}

/** NEGO sheet 同构布局的 TSV（可直接粘贴进 Excel） */
export function negoToTsv(summary: NegoSummary): string {
  return negoTable(summary)
    .map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))).join('\t'))
    .join('\n')
}

/** 比价页输入（编号 + 下单数量）→ 汇总；未找到编号或数量未填的行不计入 */
export function negoSummaryFromInputs(master: MasterData, inputs: { pn: string; qty: number | null }[]): NegoSummary {
  const lines: NegoLine[] = []
  for (const it of inputs) {
    if (it.pn.trim() === '') continue
    const res = resolveNegoInput(master, it.pn, it.qty)
    if (res.line) lines.push(res.line)
  }
  return buildNegoSummary(lines, master.layout.vendorSlots)
}
