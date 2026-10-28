import { applyMerge, planMerge, type MergeOptions, type MergePlan } from './merge'
import { deleteMasterRows } from './edit'
import { KK_COL_COUNT, type MasterCell, type MasterData, type MasterRow } from './model'
import { nextQuoteEach } from './quoteEach'
import { KK_COL, isKkVendorCol } from '../export/kkLayout'
import type { QuoteRow } from '../types'

/**
 * 总表的改动一律表示成「操作」：桌面版在本机直接应用，网页版发给 Mac 上的服务按顺序应用。
 * 操作只描述意图（改哪几格、删哪几行、并入哪些报价），不带整张表，
 * 所以每小时的后台并入和网页上的手工修改不会互相覆盖。
 */
export interface CellChange {
  row: number
  col: number
  value: MasterCell
}

export type MasterOp =
  /**
   * 改格 / 清空 / 撤销改格：逐格写入（col 0 序号也可写，供撤销还原）。
   * 改了供应商价的行，H 按各家报价平均自动重算；同一次里明确写了 H 的行（手改 H、撤销）按写的值
   */
  | { kind: 'setCells'; cells: CellChange[] }
  /** 删除整行，A 列序号重排 */
  | { kind: 'deleteRows'; rows: number[] }
  /** 删行的撤销：把原行按原下标插回，A 列序号重排 */
  | { kind: 'restoreRows'; rows: { index: number; cells: MasterCell[] }[] }
  /** 并入报价：在应用时的最新总表上重新规划，规则和桌面版「并入」相同 */
  | { kind: 'merge'; quotes: QuoteRow[]; options: MergeOptions }
  /** 导入整张汇总表（替换） */
  | { kind: 'replace'; master: MasterData }
  /** 依次应用多个操作（并入的撤销 = 还原改过的格 + 删掉新追加的尾行） */
  | { kind: 'batch'; ops: MasterOp[] }

export interface MergeSummary {
  fill: number
  append: number
  revise: number
  skip: number
  warnings: string[]
}

export interface OpResult {
  master: MasterData
  /** 撤销这次操作的反向操作；没有改动或不可撤销时为 null */
  inverse: MasterOp | null
  /** 实际改动的格数（含新增行里写入的格） */
  changedCells: number
  /** merge 操作的结果统计 */
  merge?: MergeSummary
  plan?: MergePlan
}

function emptyCells(): MasterCell[] {
  return Array.from({ length: KK_COL_COUNT }, () => null)
}

function setCells(master: MasterData, changes: CellChange[]): OpResult {
  const rows = [...master.rows]
  const touched = new Map<number, MasterRow>()
  const original = new Map<number, readonly MasterCell[]>()
  const explicitH = new Set<number>()
  const vendorChanged = new Set<number>()
  const inverse: CellChange[] = []
  for (const ch of changes) {
    if (ch.col < 0 || ch.col >= KK_COL_COUNT || ch.row < 0) continue
    if (ch.row >= rows.length) {
      if (ch.value === null) continue
      while (rows.length <= ch.row) rows.push({ cells: emptyCells() })
    }
    let row = touched.get(ch.row)
    if (!row) {
      original.set(ch.row, rows[ch.row]!.cells)
      row = { cells: [...rows[ch.row]!.cells] }
      while (row.cells.length < KK_COL_COUNT) row.cells.push(null)
      touched.set(ch.row, row)
      rows[ch.row] = row
    }
    if (ch.col === KK_COL.quoteEach) explicitH.add(ch.row)
    const before = row.cells[ch.col] ?? null
    if (before === ch.value) continue
    inverse.push({ row: ch.row, col: ch.col, value: before })
    row.cells[ch.col] = ch.value
    if (isKkVendorCol(ch.col)) vendorChanged.add(ch.row)
  }
  let changedCells = inverse.length
  // 供应商价变了的行，H 按各家报价平均重算。撤销里总带上这一行原来的 H：
  // 明确写了 H 的操作不再重算，撤销后 H 和改之前一模一样（哪怕原来的 H 不是平均价）
  for (const r of vendorChanged) {
    if (explicitH.has(r)) continue
    const row = touched.get(r)!
    const h = row.cells[KK_COL.quoteEach] ?? null
    inverse.push({ row: r, col: KK_COL.quoteEach, value: h })
    const next = nextQuoteEach(original.get(r)!, row.cells)
    if (next === undefined) continue
    row.cells[KK_COL.quoteEach] = next
    changedCells += 1
  }
  if (changedCells === 0) return { master, inverse: null, changedCells: 0 }
  return {
    master: { ...master, rows },
    inverse: { kind: 'setCells', cells: inverse.reverse() },
    changedCells,
  }
}

/** A 列序号重排（与删行同一规则） */
function renumber(master: MasterData): MasterData {
  return deleteMasterRows(master, [])
}

function restoreRows(master: MasterData, items: { index: number; cells: MasterCell[] }[]): OpResult {
  if (items.length === 0) return { master, inverse: null, changedCells: 0 }
  const rows = [...master.rows]
  const sorted = [...items].sort((a, b) => a.index - b.index)
  // 升序插回：每次的实际位置严格递增，后插的不会挪动先插的
  const at: number[] = []
  for (const it of sorted) {
    const pos = Math.min(Math.max(it.index, 0), rows.length)
    rows.splice(pos, 0, { cells: [...it.cells] })
    at.push(pos)
  }
  const next = renumber({ ...master, rows })
  return {
    master: next,
    inverse: { kind: 'deleteRows', rows: at },
    changedCells: sorted.reduce((s, it) => s + it.cells.filter((c) => c !== null).length, 0),
  }
}

function deleteRows(master: MasterData, idxs: number[]): OpResult {
  const valid = [...new Set(idxs)].filter((i) => i >= 0 && i < master.rows.length).sort((a, b) => a - b)
  if (valid.length === 0) return { master, inverse: null, changedCells: 0 }
  const removed = valid.map((index) => ({ index, cells: [...master.rows[index]!.cells] }))
  return {
    master: deleteMasterRows(master, valid),
    inverse: { kind: 'restoreRows', rows: removed },
    changedCells: removed.reduce((s, r) => s + r.cells.filter((c) => c !== null).length, 0),
  }
}

function merge(master: MasterData, quotes: QuoteRow[], options: MergeOptions): OpResult {
  const plan = planMerge(master, quotes, options)
  const next = applyMerge(master, plan)
  const base = master.rows.length
  const inverse: CellChange[] = []
  for (const a of plan.actions) {
    if (a.rowIndex >= base) continue // 追加到表尾的新行，撤销时整行删掉
    for (const ch of a.changes) inverse.push({ row: a.rowIndex, col: ch.col, value: ch.from })
    // 改了供应商价但 H 没变（已是平均价）的行，撤销时也写回原 H，免得撤销那一步又按平均重算
    if (a.changes.some((ch) => isKkVendorCol(ch.col)) && !a.changes.some((ch) => ch.col === KK_COL.quoteEach)) {
      inverse.push({ row: a.rowIndex, col: KK_COL.quoteEach, value: master.rows[a.rowIndex]!.cells[KK_COL.quoteEach] ?? null })
    }
  }
  const appended = Array.from({ length: next.rows.length - base }, (_, i) => base + i)
  const undo: MasterOp[] = []
  if (inverse.length > 0) undo.push({ kind: 'setCells', cells: inverse.reverse() })
  if (appended.length > 0) undo.push({ kind: 'deleteRows', rows: appended })
  const changedCells = plan.actions.reduce((s, a) => s + a.changes.length, 0)
  const summary: MergeSummary = {
    fill: plan.fillCount,
    append: plan.appendCount,
    revise: plan.reviseCount,
    skip: plan.skipCount,
    warnings: plan.warnings,
  }
  return {
    master: changedCells > 0 ? next : master,
    inverse: undo.length === 0 ? null : undo.length === 1 ? undo[0]! : { kind: 'batch', ops: undo },
    changedCells,
    merge: summary,
    plan,
  }
}

/** 在给定总表上应用一个操作（纯函数，不修改入参） */
export function applyMasterOp(master: MasterData, op: MasterOp): OpResult {
  switch (op.kind) {
    case 'setCells':
      return setCells(master, op.cells)
    case 'deleteRows':
      return deleteRows(master, op.rows)
    case 'restoreRows':
      return restoreRows(master, op.rows)
    case 'merge':
      return merge(master, op.quotes, op.options)
    case 'replace':
      return { master: op.master, inverse: null, changedCells: op.master.rows.length }
    case 'batch':
      return batch(master, op.ops)
  }
}

function batch(master: MasterData, ops: MasterOp[]): OpResult {
  let cur = master
  let changedCells = 0
  const undo: MasterOp[] = []
  let undoable = true
  for (const op of ops) {
    const r = applyMasterOp(cur, op)
    cur = r.master
    changedCells += r.changedCells
    if (r.inverse) undo.unshift(r.inverse)
    else if (op.kind === 'replace') undoable = false
  }
  return {
    master: cur,
    inverse: undoable && undo.length > 0 ? (undo.length === 1 ? undo[0]! : { kind: 'batch', ops: undo }) : null,
    changedCells,
  }
}

/** 操作是否会让已有行的下标移动（删行 / 插回行 / 整表替换）；只改格和并入不会 */
export function opShiftsRows(op: MasterOp): boolean {
  if (op.kind === 'batch') return op.ops.some(opShiftsRows)
  return op.kind === 'deleteRows' || op.kind === 'restoreRows' || op.kind === 'replace'
}

/** 给历史记录用的一句话说明 */
export function describeMasterOp(op: MasterOp): string {
  switch (op.kind) {
    case 'setCells':
      return `改 ${op.cells.length} 格`
    case 'deleteRows':
      return `删除 ${op.rows.length} 行`
    case 'restoreRows':
      return `恢复 ${op.rows.length} 行`
    case 'merge':
      return `并入 ${op.options.vendorDisplay} 报价 ${op.quotes.length} 条（批次 ${op.options.batch}）`
    case 'replace':
      return `整表更新：${op.master.sourceFileName ?? '新建汇总'}`
    case 'batch':
      return op.ops.map(describeMasterOp).join('；')
  }
}
