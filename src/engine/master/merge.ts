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
 *
 * 0823/0826/0828 三轮真实汇总补充的规则：
 * - 重复拖入已并入的回单（同批次同件同数量且该家价一致）→ skip，不产生重复行
 * - 同批次修订报价（重发的回单价格变了，或数量+价格都变）→ revise 原位更新；
 *   数量修订仅在该行其他家没报价时进行，否则按新行并入并提醒
 * - 跨批次同件同数量的重询 → 仍按新行并入（保留新旧价对比），warning 里点名历史批次
 * - 整行未识别到价格（如供应商把件号文本贴进价格列）→ warning 提醒
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
  /**
   * fill：空槽填充；append：追加新行；
   * revise：同批次修订报价（0826 Kit 实证：同批重发的回单数量/价格变了 → 原位更新，不追加重复行）；
   * skip：同批次同件同数量且该家价与总表一致（0823 实证：重复拖入已并入的回单 → 不动任何格）
   */
  kind: 'fill' | 'append' | 'revise' | 'skip'
  /** fill/revise/skip: 目标行在 rows 里的下标；append: 占用的预编号行下标或 rows.length+n */
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
  reviseCount: number
  skipCount: number
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

/** 待定占位（用户在总表手工填的 TDB/TBD/待定）视同可填充：真报价到了就替换 */
function isFillableCell(v: MasterCell | undefined): boolean {
  return isEmptyCell(v) || /^(tdb|tbd|待定)$/i.test(String(v).trim())
}

/** 材料等价（跨中英/空格/连字符）：'殷钢 36'≠'invar-36'，但 'SS 416'≈'SS-416'、'6061'≈'AL 6061'子串不算 —— 仅归一化后全等 */
const normMaterial = (v: MasterCell | string | undefined): string =>
  String(v ?? '')
    .toLowerCase()
    .replace(/[\s\-_,，()（）]/g, '')
const materialEq = (a: MasterCell | undefined, b: string): boolean => {
  const na = normMaterial(a)
  const nb = normMaterial(b)
  return na !== '' && nb !== '' && na === nb
}

/** 报价值 → 汇总单元格：ok 存数字，TDB/待定存 "TDB"，其余不写 */
function priceCellValue(q: QuoteRow): MasterCell | undefined {
  if (q.price.status === 'ok' && q.price.amount !== undefined) return q.price.amount
  if (q.price.status === 'pending') return 'TDB'
  return undefined
}

/** 单元格按金额解析（数字或 '￥1,235.00' 类文本） */
function cellAmount(v: MasterCell | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v ?? '').trim()
  return s === '' ? null : cleanAmountString(s)
}

/** 该家槽位现值与本次报价等值：数字相等，或双方都是 TDB 占位 */
function slotEqualsQuote(cell: MasterCell | undefined, q: QuoteRow): boolean {
  if (q.price.status === 'ok' && q.price.amount !== undefined) return cellAmount(cell) === q.price.amount
  if (q.price.status === 'pending') return /^(tdb|tbd|待定)$/i.test(String(cell ?? '').trim())
  return false
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
    // H 选定价 / U 对客报价：只有报价文件带 Quote(EA)（KV 家）才带入，且只填空（TDB 占位视同空）
    if (q.quoteEa) {
      if (isFillableCell(cells[KK_COL.quoteEach]) && price !== undefined) set(KK_COL.quoteEach, price)
      if (isFillableCell(cells[KK_COL.quoteEa])) set(KK_COL.quoteEa, numericOr(q.quoteEa))
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

  const batchName = opts.batch.trim()
  const rowBatchEq = (row: MasterRow): boolean => String(row.cells[KK_COL.name] ?? '').trim() === batchName

  // ---------- 第 0 遍：同批次「已在表内」与「修订报价」（0823/0826 数据任务实证） ----------
  const preResolved = new Map<number, MergeAction>()

  // a) 跳过：同批次 + 同 P/N + 同数量 + 该家槽位值与本次一致 → 重复拖入，不动任何格
  quotes.forEach((q, qi) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (claimed.has(i)) continue
      const row = rows[i]!
      if (isPlaceholderRow(row) || !rowBatchEq(row)) continue
      if (normPn(row.cells[KK_COL.pn]) !== normPn(q.pn)) continue
      if (!numEq(row.cells[KK_COL.qty] ?? null, q.qty)) continue
      if (!slotEqualsQuote(row.cells[opts.vendorSlot], q)) continue
      claimed.add(i)
      preResolved.set(qi, { kind: 'skip', rowIndex: i, excelRow: i + 2, quote: q, changes: [] })
      return
    }
  })

  // b) 修订：同批次重发的回单价格/数量变了 → 原位更新（不追加重复行）
  const pnCountInFile = new Map<string, number>()
  for (const q of quotes) pnCountInFile.set(normPn(q.pn), (pnCountInFile.get(normPn(q.pn)) ?? 0) + 1)
  const buildReviseChanges = (row: MasterRow, q: QuoteRow): MergeChange[] => {
    const cells = row.cells
    const changes: MergeChange[] = []
    const set = (col: number, to: MasterCell) => {
      if (cells[col] === to) return
      changes.push({ col, from: cells[col] ?? null, to })
    }
    const oldSlot = cellAmount(cells[opts.vendorSlot])
    const price = priceCellValue(q)
    if (price !== undefined) set(opts.vendorSlot, price)
    if (q.qty !== null && !numEq(cells[KK_COL.qty] ?? null, q.qty)) set(KK_COL.qty, q.qty)
    // H 选定价 / U 对客报价：现 H 等于修订前该家槽位值（说明来自同一家）时才跟随更新
    if (q.quoteEa && price !== undefined && oldSlot !== null && cellAmount(cells[KK_COL.quoteEach]) === oldSlot) {
      set(KK_COL.quoteEach, price)
      set(KK_COL.quoteEa, numericOr(q.quoteEa))
    }
    // V 真报价单号：修订单若带新单号则拼接（沿用填充规则）
    if (q.quoteNo && isRealQuoteNo(q.quoteNo)) {
      const existing = String(cells[KK_COL.quoteNo] ?? '').trim()
      if (!existing) set(KK_COL.quoteNo, q.quoteNo)
      else if (!existing.split('/').includes(q.quoteNo)) set(KK_COL.quoteNo, `${existing}/${q.quoteNo}`)
    }
    // W 是多家拼接文本，交期变了不自动改，提示人工核对
    if (q.leadTime.raw) {
      const fmt = formatLeadTime(q.leadTime)
      const existing = String(cells[KK_COL.leadTime] ?? '').trim()
      if (!existing) set(KK_COL.leadTime, fmt)
      else if (!existing.split('/').includes(fmt))
        warnings.push(`${q.pn}×${q.qty ?? ''}：修订交期 ${fmt} 与总表 W「${existing}」不同，未自动改，请人工核对`)
    }
    if (q.remark) {
      const existing = String(cells[KK_COL.comment] ?? '').trim()
      if (!existing) set(KK_COL.comment, q.remark)
      else if (!existing.includes(q.remark)) set(KK_COL.comment, `${existing}；${opts.vendorDisplay}:${q.remark}`)
    }
    return changes
  }
  quotes.forEach((q, qi) => {
    if (preResolved.has(qi)) return
    if (priceCellValue(q) === undefined) return
    // 目标：同批次 + 同 P/N + 该家槽位已有值；同数量 → 价格修订；
    // 数量也变了 → 仅当该 P/N 在本文件与该批次中都唯一、且其他家槽位为空（改数量不会弄脏别家价）
    let target = -1
    let qtyChanged = false
    for (let i = rows.length - 1; i >= 0; i--) {
      if (claimed.has(i)) continue
      const row = rows[i]!
      if (isPlaceholderRow(row) || !rowBatchEq(row)) continue
      if (normPn(row.cells[KK_COL.pn]) !== normPn(q.pn)) continue
      if (isFillableCell(row.cells[opts.vendorSlot])) continue
      if (numEq(row.cells[KK_COL.qty] ?? null, q.qty)) {
        target = i
        qtyChanged = false
        break
      }
      if (pnCountInFile.get(normPn(q.pn)) !== 1) continue
      // 数量修订与「新增数量档」（0828 Vijetha ×4）在数据上无法区分——只有整单重发
      // （同文件里已有其他行与总表一致，0826 Kit：7 行原样 + 4 行改档）才按修订处理
      if (preResolved.size === 0) continue
      const sameBatchSamePn = rows.filter(
        (r, ri) => !claimed.has(ri) && !isPlaceholderRow(r) && rowBatchEq(r) && normPn(r.cells[KK_COL.pn]) === normPn(q.pn),
      )
      if (sameBatchSamePn.length !== 1) continue
      const otherSlotsBusy = [8, 9, 10, 11, 12, 13].some(
        (s) => s !== opts.vendorSlot && !isFillableCell(row.cells[s]),
      )
      if (otherSlotsBusy) {
        warnings.push(`${q.pn}：数量 ${row.cells[KK_COL.qty]}→${q.qty} 的修订行已有其他家报价，改按新行并入，请人工核对`)
        continue
      }
      target = i
      qtyChanged = true
      break
    }
    if (target < 0) return
    const row = rows[target]!
    const changes = buildReviseChanges(row, q)
    if (changes.length === 0) {
      preResolved.set(qi, { kind: 'skip', rowIndex: target, excelRow: target + 2, quote: q, changes: [] })
    } else {
      const oldPrice = cellAmount(row.cells[opts.vendorSlot])
      const detail = qtyChanged
        ? `数量 ${row.cells[KK_COL.qty]}→${q.qty}、价 ${oldPrice ?? '—'}→${q.price.amount ?? '—'}`
        : `价 ${oldPrice ?? '—'}→${q.price.amount ?? '—'}`
      warnings.push(`${q.pn}×${q.qty ?? ''}：识别为同批次修订报价（${detail}），已原位更新第 ${target + 2} 行`)
      preResolved.set(qi, { kind: 'revise', rowIndex: target, excelRow: target + 2, quote: q, changes })
    }
    claimed.add(target)
  })

  // 候选行：同 P/N + 同数量 + 该家槽位可填（空或 TDB 占位），自底向上
  const candidatesOf = (q: QuoteRow): number[] => {
    const out: number[] = []
    for (let i = rows.length - 1; i >= 0; i--) {
      if (claimed.has(i)) continue
      const row = rows[i]!
      if (isPlaceholderRow(row)) continue
      if (normPn(row.cells[KK_COL.pn]) !== normPn(q.pn)) continue
      if (!numEq(row.cells[KK_COL.qty] ?? null, q.qty)) continue
      if (!isFillableCell(row.cells[opts.vendorSlot])) continue
      out.push(i)
    }
    return out
  }

  // 第一遍：材料能对上的先配对——同零件同数量多行只差材料（如 Invar/SS-416/SS-303 各一行）时，
  // 报价必须按材料落行，不能只按自底向上抢占
  const fillTarget = new Map<number, number>()
  quotes.forEach((q, qi) => {
    if (preResolved.has(qi)) return
    if (!q.material) return
    const cands = candidatesOf(q)
    const m = cands.find((i) => materialEq(rows[i]!.cells[KK_COL.material], q.material))
    if (m !== undefined) {
      fillTarget.set(qi, m)
      claimed.add(m)
    }
  })

  quotes.forEach((q, qi) => {
    const pre = preResolved.get(qi)
    if (pre) {
      actions.push(pre)
      return
    }
    let target = fillTarget.get(qi) ?? -1
    if (target < 0) {
      const cands = candidatesOf(q)
      if (cands.length > 0) target = cands[0]!
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
  })

  // 跨批次重询提示（0828 Valeryan 实证）：追加的行若与历史批次同件同数量且已有价，按新行并入并提醒
  const reinquiries: string[] = []
  for (const a of actions) {
    if (a.kind !== 'append') continue
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!
      if (isPlaceholderRow(row) || rowBatchEq(row)) continue
      if (normPn(row.cells[KK_COL.pn]) !== normPn(a.quote.pn)) continue
      if (!numEq(row.cells[KK_COL.qty] ?? null, a.quote.qty)) continue
      if (![8, 9, 10, 11, 12, 13].some((s) => !isFillableCell(row.cells[s]))) continue
      reinquiries.push(`${a.quote.pn}×${a.quote.qty ?? ''}（历史批次「${String(row.cells[KK_COL.name] ?? '').trim()}」）`)
      break
    }
  }
  if (reinquiries.length > 0) {
    const head = reinquiries.slice(0, 5).join('、')
    warnings.push(
      `${reinquiries.length} 行与历史批次同件同数量（重询），已按新行并入便于对比新旧价：${head}${reinquiries.length > 5 ? ` 等 ${reinquiries.length} 处` : ''}`,
    )
  }

  // 整行没有识别到价格（0823 Bhupen 实证：供应商把件号文本贴进了价格列）
  const noPrice = quotes.filter((q) => priceCellValue(q) === undefined)
  if (noPrice.length > 0) {
    const head = noPrice.slice(0, 3).map((q) => `${q.pn}×${q.qty ?? ''}`).join('、')
    warnings.push(
      `${noPrice.length} 行未识别到价格（${head}${noPrice.length > 3 ? ' 等' : ''}），该家价格列将留空——请检查原件是否漏报`,
    )
  }

  const count = (k: MergeAction['kind']) => actions.filter((a) => a.kind === k).length
  return {
    actions,
    fillCount: count('fill'),
    appendCount: count('append'),
    reviseCount: count('revise'),
    skipCount: count('skip'),
    warnings,
  }
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
