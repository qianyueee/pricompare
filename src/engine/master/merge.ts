import { formatLeadTime } from '../normalize/leadtime'
import { cleanAmountString } from './clean'
import { KK_COL } from '../export/kkLayout'
import { isPlaceholderRow, KK_COL_COUNT, type MasterCell, type MasterData, type MasterRow } from './model'
import type { QuoteRow } from '../types'

/**
 * 合并规则（从用户 0812→0814 两份汇总快照逐单元格 diff 实证）：
 * - 每条报价行（P/N × 数量档）自底向上找「P/N 相同 + 数量相同 + 该供应商列还空着」的行 → 填入；
 *   找不到则追加（优先占用底部只有 A 列序号的预编号空行）
 * - W 交期按供应商列序拼接（HC 在 J、SKW 在 K → "18Days/3 weeks+cleaning"）
 * - V 只收真报价单号（KV202608151 这类），"询价 20260814 Natalie A" 是批次标签不进 V
 * - H 选定价 / U 对客报价：来自带 Quote(EA) 的报价文件（KV 家宏算好的），只填空不覆盖
 * - 材料/表面处理等明细：空则填；SKW 的值可覆盖别家（观察到 KV 中文规格优先）
 */

export interface MergeOptions {
  /** 汇总 B 列批次名（如 "20260814 Natalie A"） */
  batch: string
  /** 该供应商在汇总里的列（0 基，I–N 为 8–13） */
  vendorSlot: number
  vendorId: string
  vendorDisplay: string
}

export interface MergeChange {
  col: number
  from: MasterCell
  to: MasterCell
}

export interface MergeAction {
  kind: 'fill' | 'append'
  /** fill: 目标行在 rows 里的下标；append: 占用的预编号行下标或 rows.length+n */
  rowIndex: number
  /** 1 基 Excel 行号（表头第 1 行，数据行 = 下标 + 2） */
  excelRow: number
  quote: QuoteRow
  changes: MergeChange[]
}

export interface MergePlan {
  actions: MergeAction[]
  fillCount: number
  appendCount: number
  warnings: string[]
}

/** 真报价单号：字母前缀 + 长数字（KV202608151 / KT20260711B）；批次标签（含"询价"或空格开头）不算 */
export function isRealQuoteNo(s: string): boolean {
  const t = s.trim()
  if (!t || /询价/.test(t)) return false
  return /^[A-Za-z]{1,5}\d{4,}[A-Za-z0-9-]*$/.test(t)
}

const normPn = (v: MasterCell | string): string => String(v ?? '').trim().toUpperCase()

/**
 * 从报价内容猜汇总批次名（B 列）：
 * HC 家把批次写在 Quote No. 列（"询价 20260814 Natalie A"）→ 去掉"询价"前缀；
 * 文件名里带 "..._20260814_Natalie_A" 时也能取到；都没有则返回 ''（由界面默认今天日期）。
 */
export function guessBatchLabel(quotes: QuoteRow[], fileName: string): string {
  for (const q of quotes) {
    const m = q.quoteNo.match(/询价\s*(.+)/)
    if (m?.[1]) return m[1].trim()
  }
  const fm = fileName.match(/询价[_\s]*(\d{8}[_\s][^.]+?)(?:\.[A-Za-z]+)?$/)
  if (fm?.[1]) return fm[1].replace(/_/g, ' ').trim()
  return ''
}

function numEq(a: MasterCell, b: number | null): boolean {
  if (b === null) return a === null || String(a).trim() === ''
  const n = Number(String(a ?? '').trim())
  return Number.isFinite(n) && n === b
}

function isEmptyCell(v: MasterCell | undefined): boolean {
  return v === null || v === undefined || String(v).trim() === ''
}

/** 报价值 → 汇总单元格：ok 存数字，TDB/待定存 "TDB"，其余不写 */
function priceCellValue(q: QuoteRow): MasterCell | undefined {
  if (q.price.status === 'ok' && q.price.amount !== undefined) return q.price.amount
  if (q.price.status === 'pending') return 'TDB'
  return undefined
}

function numericOr(v: string): MasterCell {
  const n = cleanAmountString(v)
  return n !== null ? n : v
}

export function planMerge(master: MasterData, quotes: QuoteRow[], opts: MergeOptions): MergePlan {
  const rows = master.rows
  const claimed = new Set<number>()
  const actions: MergeAction[] = []
  const warnings: string[] = []

  // 追加目标：底部连续的预编号空行（自上而下依次占用）
  const placeholderIdxs: number[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isPlaceholderRow(rows[i]!)) placeholderIdxs.unshift(i)
    else break
  }
  let placeholderPtr = 0
  let appendExtra = 0
  let lastNo = 0
  for (const row of rows) {
    const n = Number(String(row.cells[0] ?? '').trim())
    if (Number.isFinite(n) && n > lastNo) lastNo = n
  }

  const specFields: [number, keyof QuoteRow][] = [
    [KK_COL.material, 'material'],
    [KK_COL.surfaceFinish, 'surfaceFinish'],
    [KK_COL.cleaningSpec, 'cleaningSpec'],
    [KK_COL.process, 'process'],
    [KK_COL.size, 'size'],
    [KK_COL.partType, 'partType'],
    [KK_COL.basePn, 'basePn'],
  ]

  const buildChanges = (row: MasterRow | null, q: QuoteRow): MergeChange[] => {
    const cells = row?.cells ?? Array.from({ length: KK_COL_COUNT }, () => null as MasterCell)
    const changes: MergeChange[] = []
    const set = (col: number, to: MasterCell) => {
      if (cells[col] === to) return
      changes.push({ col, from: cells[col] ?? null, to })
    }
    // 供应商价格列
    const price = priceCellValue(q)
    if (price !== undefined) set(opts.vendorSlot, price)
    // 基础信息只填空
    if (isEmptyCell(cells[KK_COL.name]) && opts.batch) set(KK_COL.name, opts.batch)
    if (isEmptyCell(cells[KK_COL.item]) && q.item) set(KK_COL.item, numericOr(q.item))
    if (isEmptyCell(cells[KK_COL.pn])) set(KK_COL.pn, q.pn)
    if (isEmptyCell(cells[KK_COL.rev]) && q.rev) set(KK_COL.rev, q.rev)
    if (isEmptyCell(cells[KK_COL.description]) && q.description) set(KK_COL.description, q.description)
    if (isEmptyCell(cells[KK_COL.qty]) && q.qty !== null) set(KK_COL.qty, q.qty)
    // H 选定价 / U 对客报价：只有报价文件带 Quote(EA)（KV 家）才带入，且只填空
    if (q.quoteEa) {
      if (isEmptyCell(cells[KK_COL.quoteEach]) && price !== undefined) set(KK_COL.quoteEach, price)
      if (isEmptyCell(cells[KK_COL.quoteEa])) set(KK_COL.quoteEa, numericOr(q.quoteEa))
    }
    // V 真报价单号
    if (q.quoteNo && isRealQuoteNo(q.quoteNo)) {
      const existing = String(cells[KK_COL.quoteNo] ?? '').trim()
      if (!existing) set(KK_COL.quoteNo, q.quoteNo)
      else if (!existing.split('/').includes(q.quoteNo)) set(KK_COL.quoteNo, `${existing}/${q.quoteNo}`)
    }
    // W 交期按列序拼接：J（HC）以左的供应商放前面，K 及以右追加在后
    if (q.leadTime.raw) {
      const fmt = formatLeadTime(q.leadTime)
      const existing = String(cells[KK_COL.leadTime] ?? '').trim()
      if (!existing) set(KK_COL.leadTime, fmt)
      else if (!existing.split('/').includes(fmt)) {
        set(
          KK_COL.leadTime,
          opts.vendorSlot <= KK_COL.vendorSlotStart + 1 ? `${fmt}/${existing}` : `${existing}/${fmt}`,
        )
      }
    }
    // 明细：空则填；SKW 的规格可覆盖别家（不覆盖备注）
    for (const [col, field] of specFields) {
      const v = q[field]
      if (typeof v !== 'string' || !v) continue
      if (isEmptyCell(cells[col])) set(col, v)
      else if (opts.vendorId === 'skw' && String(cells[col]).trim() !== v) set(col, v)
    }
    if (q.remark) {
      const existing = String(cells[KK_COL.comment] ?? '').trim()
      if (!existing) set(KK_COL.comment, q.remark)
      else if (!existing.includes(q.remark)) set(KK_COL.comment, `${existing}；${opts.vendorDisplay}:${q.remark}`)
    }
    return changes
  }

  for (const q of quotes) {
    // 自底向上找可填充的既有行
    let target = -1
    for (let i = rows.length - 1; i >= 0; i--) {
      if (claimed.has(i)) continue
      const row = rows[i]!
      if (isPlaceholderRow(row)) continue
      if (normPn(row.cells[KK_COL.pn]) !== normPn(q.pn)) continue
      if (!numEq(row.cells[KK_COL.qty] ?? null, q.qty)) continue
      if (!isEmptyCell(row.cells[opts.vendorSlot])) continue
      target = i
      break
    }
    if (target >= 0) {
      claimed.add(target)
      actions.push({
        kind: 'fill',
        rowIndex: target,
        excelRow: target + 2,
        quote: q,
        changes: buildChanges(rows[target]!, q),
      })
    } else {
      let rowIndex: number
      let baseRow: MasterRow | null = null
      if (placeholderPtr < placeholderIdxs.length) {
        rowIndex = placeholderIdxs[placeholderPtr++]!
        baseRow = rows[rowIndex]!
        claimed.add(rowIndex)
      } else {
        rowIndex = rows.length + appendExtra++
      }
      const changes = buildChanges(baseRow, q)
      if (!baseRow) {
        lastNo += 1
        changes.unshift({ col: 0, from: null, to: lastNo })
      }
      actions.push({ kind: 'append', rowIndex, excelRow: rowIndex + 2, quote: q, changes })
    }
  }

  const fillCount = actions.filter((a) => a.kind === 'fill').length
  return { actions, fillCount, appendCount: actions.length - fillCount, warnings }
}

/** 应用合并计划，返回新的 MasterData（不修改原对象） */
export function applyMerge(master: MasterData, plan: MergePlan): MasterData {
  const rows = master.rows.map((r) => ({ cells: [...r.cells] }))
  for (const action of plan.actions) {
    while (rows.length <= action.rowIndex) {
      rows.push({ cells: Array.from({ length: KK_COL_COUNT }, () => null as MasterCell) })
    }
    const row = rows[action.rowIndex]!
    for (const ch of action.changes) row.cells[ch.col] = ch.to
  }
  return { ...master, rows }
}
