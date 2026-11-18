import { KK_COL } from '../export/kkLayout'
import { isDataRow, isPlaceholderRow, KK_COL_COUNT, type MasterCell, type MasterData, type MasterRowOrigin } from './model'

/**
 * 预建询价行（Zane 2026-11-18）：询价邮箱流程收到客户 RFQ、发出询价的同时，在总表里先把这批的行建出来——
 * 每个零件 × 每档数量一行，填 B 询价组、C Item、D P/N、E Rev、F 描述、G 数量和 X–AA 规格，
 * 价格、交期、备注、报价单号留空。之后报价并入时按「同 P/N + 同数量 + 该家列空着」落到这些行上，不再新建。
 *
 * 和并入一样在应用时按最新总表规划：同组里已有同 P/N + 同数量的行 → 跳过（同一封 RFQ 重跑不会重复建行）；
 * 新行先占底部只有 A 列序号的预编号空行，不够再接在表尾，A 列 = 现有最大序号 + 1（不重排已有序号）。
 */

export interface AddRowInput {
  item?: string | number | null
  pn: string
  rev?: string | null
  description?: string | null
  qty?: number | null
  material?: string | null
  surfaceFinish?: string | null
  cleaningSpec?: string | null
  process?: string | null
}

export interface AddRowsPlanItem {
  input: AddRowInput
  /** add：建新行；skip：组里已有同 P/N + 同数量的行 */
  kind: 'add' | 'skip'
  /** add：新行（或占用的预编号行）在 rows 里的下标；skip：已有那行的下标 */
  rowIndex: number
  /** add：整行的值（A 列已编好号；占用预编号行时沿用它的序号） */
  cells?: MasterCell[]
}

export interface AddRowsPlan {
  items: AddRowsPlanItem[]
  addCount: number
  skipCount: number
}

const normPn = (v: MasterCell | string | undefined): string => String(v ?? '').trim().toUpperCase()
const text = (v: string | number | null | undefined): string => (v === null || v === undefined ? '' : String(v).trim())

function sameQty(a: MasterCell | undefined, b: number | null | undefined): boolean {
  if (b === null || b === undefined) return a === null || a === undefined || String(a).trim() === ''
  const n = Number(String(a ?? '').trim())
  return String(a ?? '').trim() !== '' && Number.isFinite(n) && n === b
}

/** 文本里是纯数字就存数字（Item 1、2…），否则原样 */
function numOrText(v: string): MasterCell {
  return /^\d+$/.test(v) ? Number(v) : v
}

export function planAddRows(master: MasterData, batch: string, inputs: AddRowInput[]): AddRowsPlan {
  const rows = master.rows
  const name = batch.trim()
  const items: AddRowsPlanItem[] = []
  // 底部连续的预编号空行（自上而下依次占用），和并入的规则一样
  const placeholders: number[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isPlaceholderRow(rows[i]!)) placeholders.unshift(i)
    else break
  }
  let lastNo = 0
  for (const row of rows) {
    const n = Number(String(row.cells[0] ?? '').trim())
    if (Number.isFinite(n) && n > lastNo) lastNo = n
  }
  let ph = 0
  let extra = 0
  const added: { pn: string; qty: number | null | undefined }[] = []
  for (const input of inputs) {
    const pn = text(input.pn)
    const qty = input.qty === undefined || input.qty === null || !Number.isFinite(Number(input.qty)) ? null : Number(input.qty)
    // 组里已有（之前建过，或供应商报价先到、已经新建了这一行）→ 跳过
    let existing = -1
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!
      if (!isDataRow(row) || isPlaceholderRow(row)) continue
      if (String(row.cells[KK_COL.name] ?? '').trim() !== name) continue
      if (normPn(row.cells[KK_COL.pn]) !== normPn(pn)) continue
      if (!sameQty(row.cells[KK_COL.qty], qty)) continue
      existing = i
      break
    }
    if (existing >= 0 || added.some((a) => normPn(a.pn) === normPn(pn) && a.qty === qty)) {
      items.push({ input, kind: 'skip', rowIndex: existing })
      continue
    }
    const cells: MasterCell[] = Array.from({ length: KK_COL_COUNT }, () => null)
    let rowIndex: number
    if (ph < placeholders.length) {
      rowIndex = placeholders[ph++]!
      cells[0] = rows[rowIndex]!.cells[0] ?? null
    } else {
      rowIndex = rows.length + extra++
      lastNo += 1
      cells[0] = lastNo
    }
    const set = (col: number, v: string | number | null | undefined) => {
      const t = text(v)
      if (t !== '') cells[col] = t
    }
    cells[KK_COL.name] = name
    const item = text(input.item)
    if (item) cells[KK_COL.item] = numOrText(item)
    cells[KK_COL.pn] = pn
    set(KK_COL.rev, input.rev ? text(input.rev).toUpperCase() : '')
    set(KK_COL.description, input.description)
    cells[KK_COL.qty] = qty
    set(KK_COL.material, input.material)
    set(KK_COL.surfaceFinish, input.surfaceFinish)
    set(KK_COL.cleaningSpec, input.cleaningSpec)
    set(KK_COL.process, input.process)
    added.push({ pn, qty })
    items.push({ input, kind: 'add', rowIndex, cells })
  }
  return {
    items,
    addCount: items.filter((i) => i.kind === 'add').length,
    skipCount: items.filter((i) => i.kind === 'skip').length,
  }
}

/** 按计划写入（不修改原对象），新行带上来历标记 */
export function applyAddRows(master: MasterData, plan: AddRowsPlan, origin?: MasterRowOrigin): MasterData {
  const adds = plan.items.filter((i) => i.kind === 'add' && i.cells)
  if (adds.length === 0) return master
  const rows = [...master.rows]
  for (const a of adds) {
    while (rows.length <= a.rowIndex) rows.push({ cells: Array.from({ length: KK_COL_COUNT }, () => null) })
    rows[a.rowIndex] = origin ? { cells: [...a.cells!], origin } : { cells: [...a.cells!] }
  }
  return { ...master, rows }
}
