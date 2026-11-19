import { formatLeadTime } from '../normalize/leadtime'
import { cleanAmountString } from './clean'
import { KK_COL, KK_VENDOR_COLS } from '../export/kkLayout'
import { isPlaceholderRow, KK_COL_COUNT, withCells, type MasterCell, type MasterData, type MasterRow, type MasterRowOrigin } from './model'
import { nextQuoteEach } from './quoteEach'
import { kzQuoteNo, normalizeReceivedDate, todayYmd } from './quoteNo'
import type { QuoteRow } from '../types'

/**
 * 合并规则（从用户 0812→0814 两份汇总快照逐单元格 diff 实证）：
 * - 每条报价行（P/N × 数量档）自底向上找「P/N 相同 + 数量相同 + 该供应商列还空着」的行 → 填入；
 *   找不到则追加（优先占用底部只有 A 列序号的预编号空行）
 * - W 交期按供应商列序拼接（HC 在 J、SKW 在 K → "18Days/3 weeks+cleaning"）
 * - V 报价单号由我们自己编（Zane 2026-10-31）：KZ + 收到报价的日期 + 字母（KZ20261031A），同组同一天共用一个，
 *   只写进 V 空着、这次写了价的行，见 quoteNo.ts；供应商自己的单号（凯维的 KV…）不再进 V
 * - H Quote (each)：这一行各家数字报价的平均，向上取整到个位（Zane 2026-10-28，见 quoteEach.ts），
 *   每并入一家就重算；U 对客报价：来自带 Quote(EA) 的报价文件（KV 家宏算好的），只填空不覆盖
 * - 材料/表面处理等明细：空则填；SKW 的值可覆盖别家（观察到 KV 中文规格优先）。
 *   例外：询价邮箱流程收到 RFQ 时预建的行（origin = intake，Zane 2026-11-18），规格按图纸填好了，
 *   报价只填价格、交期、备注，规格列只在空着时才填，谁都不覆盖
 * - 同 P/N + 同数量的空行有好几处时，先落本组（B 列 = 本次批次名）的行，再按自底向上找别组的（预建行常比报价早到很多）
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
  /** 收到这份报价的日期（YYYYMMDD 或 2026-10-31），V 列 KZ 单号用；不给或认不出就用今天（本机时区） */
  receivedDate?: string
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
  /** append：新行沿用本组预建行（同料号别的数量档）的料号信息和规格，也记成预建行 */
  origin?: MasterRowOrigin
}

export interface MergePlan {
  actions: MergeAction[]
  fillCount: number
  appendCount: number
  reviseCount: number
  skipCount: number
  warnings: string[]
}

const normPn = (v: MasterCell | string): string => String(v ?? '').trim().toUpperCase()
/** 料号去掉版本后缀（华臣有时写成 1330723-000_AA）。只用来比预建行：预建行的料号是干净的，报价写法不一 */
const basePn = (v: MasterCell | string): string => normPn(v).replace(/^(\d{7}-\d{3})[_\s]+(?:REV\.?\s*)?[A-Z]{1,2}$/, '$1')
/** 这行是不是这个料号：预建行忽略版本后缀，其他行照旧整串比 */
const pnMatch = (row: MasterRow, pn: string): boolean =>
  row.origin === 'intake' ? basePn(row.cells[KK_COL.pn]) === basePn(pn) : normPn(row.cells[KK_COL.pn]) === normPn(pn)

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

/** 该家槽位写入 price 后，H 按各家报价平均重算（槽位没变或 H 不用改时不记改动） */
function setQuoteEach(
  cells: readonly MasterCell[],
  slot: number,
  price: MasterCell,
  set: (col: number, to: MasterCell) => void,
): void {
  if (cells[slot] === price) return
  const after = [...cells]
  after[slot] = price
  const h = nextQuoteEach(cells, after)
  if (h !== undefined) set(KK_COL.quoteEach, h)
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
  // V 报价单号：本组本日的 KZ 单号（同组当天已有就沿用）
  const quoteNo = kzQuoteNo(master, opts.batch, normalizeReceivedDate(opts.receivedDate) ?? todayYmd())

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
    // 供应商价格列；H 按各家报价平均重算
    const price = priceCellValue(q)
    if (price !== undefined) {
      set(opts.vendorSlot, price)
      setQuoteEach(cells, opts.vendorSlot, price, set)
    }
    // 基础信息只填空
    if (isEmptyCell(cells[KK_COL.name]) && opts.batch) set(KK_COL.name, opts.batch)
    if (isEmptyCell(cells[KK_COL.item]) && q.item) set(KK_COL.item, numericOr(q.item))
    if (isEmptyCell(cells[KK_COL.pn])) set(KK_COL.pn, q.pn)
    if (isEmptyCell(cells[KK_COL.rev]) && q.rev) set(KK_COL.rev, q.rev)
    if (isEmptyCell(cells[KK_COL.description]) && q.description) set(KK_COL.description, q.description)
    if (isEmptyCell(cells[KK_COL.qty]) && q.qty !== null) set(KK_COL.qty, q.qty)
    // U 对客报价：只有报价文件带 Quote(EA)（KV 家）才带入，且只填空（TDB 占位视同空）
    if (q.quoteEa && isFillableCell(cells[KK_COL.quoteEa])) set(KK_COL.quoteEa, numericOr(q.quoteEa))
    // V 报价单号：这次写了价、V 还空着 → 本组本日的 KZ 单号；已有的单号不动
    if (price !== undefined && isEmptyCell(cells[KK_COL.quoteNo])) set(KK_COL.quoteNo, quoteNo)
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
    // 明细：空则填；SKW 的规格可覆盖别家（不覆盖备注）；预建行（按图纸填好的）谁都不覆盖
    const specsLocked = row?.origin === 'intake'
    for (const [col, field] of specFields) {
      const v = q[field]
      if (typeof v !== 'string' || !v) continue
      if (isEmptyCell(cells[col])) set(col, v)
      else if (opts.vendorId === 'skw' && !specsLocked && String(cells[col]).trim() !== v) set(col, v)
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
      if (!pnMatch(row, q.pn)) continue
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
    const price = priceCellValue(q)
    if (price !== undefined) {
      set(opts.vendorSlot, price)
      setQuoteEach(cells, opts.vendorSlot, price, set)
    }
    if (q.qty !== null && !numEq(cells[KK_COL.qty] ?? null, q.qty)) set(KK_COL.qty, q.qty)
    // U 对客报价：KV 家修订单带了新的 Quote(EA) 就跟着更新（U 只存着，导出时按 H 写公式重算）
    if (q.quoteEa && price !== undefined) set(KK_COL.quoteEa, numericOr(q.quoteEa))
    // V 报价单号：修订行原有的单号不动，还空着才补本组本日的 KZ 单号
    if (price !== undefined && isEmptyCell(cells[KK_COL.quoteNo])) set(KK_COL.quoteNo, quoteNo)
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
      if (!pnMatch(row, q.pn)) continue
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
        (r, ri) => !claimed.has(ri) && !isPlaceholderRow(r) && rowBatchEq(r) && pnMatch(r, q.pn),
      )
      if (sameBatchSamePn.length !== 1) continue
      const otherSlotsBusy = KK_VENDOR_COLS.some(
        ({ col }) => col !== opts.vendorSlot && !isFillableCell(row.cells[col]),
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

  // 候选行：同 P/N + 同数量 + 该家槽位可填（空或 TDB 占位）；本组的行在前，各自自底向上。
  // 本组预建时没有数量的行（客户询价没写数量）也算，排在同数量的后面：报价落进来时数量照报价填
  const candidatesOf = (q: QuoteRow): number[] => {
    const own: number[] = []
    const noQty: number[] = []
    const other: number[] = []
    for (let i = rows.length - 1; i >= 0; i--) {
      if (claimed.has(i)) continue
      const row = rows[i]!
      if (isPlaceholderRow(row)) continue
      if (!pnMatch(row, q.pn)) continue
      if (!isFillableCell(row.cells[opts.vendorSlot])) continue
      const ownBatch = !!batchName && rowBatchEq(row)
      if (!numEq(row.cells[KK_COL.qty] ?? null, q.qty)) {
        if (q.qty !== null && ownBatch && row.origin === 'intake' && isEmptyCell(row.cells[KK_COL.qty])) noQty.push(i)
        continue
      }
      ;(ownBatch ? own : other).push(i)
    }
    return [...own, ...noQty, ...other]
  }

  // 本组这个料号的预建行（报价多出来的数量档要新建行时，照它填料号信息和规格）
  const TEMPLATE_COLS = [
    KK_COL.name, KK_COL.item, KK_COL.pn, KK_COL.rev, KK_COL.description,
    KK_COL.material, KK_COL.surfaceFinish, KK_COL.cleaningSpec, KK_COL.process,
  ]
  const intakeTemplate = (q: QuoteRow): MasterRow | null => {
    if (!batchName) return null
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!
      if (row.origin === 'intake' && rowBatchEq(row) && pnMatch(row, q.pn)) return row
    }
    return null
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
      const tmpl = intakeTemplate(q)
      let changes: MergeChange[]
      if (tmpl) {
        const start: MasterCell[] = baseRow ? [...baseRow.cells] : Array.from({ length: KK_COL_COUNT }, () => null)
        const copied: MergeChange[] = []
        for (const col of TEMPLATE_COLS) {
          const v = tmpl.cells[col] ?? null
          if (v === null || v === start[col]) continue
          copied.push({ col, from: start[col] ?? null, to: v })
          start[col] = v
        }
        changes = [...copied, ...buildChanges({ cells: start, origin: 'intake' }, q)]
      } else changes = buildChanges(baseRow, q)
      if (!baseRow) {
        lastNo += 1
        changes.unshift({ col: 0, from: null, to: lastNo })
      }
      actions.push({ kind: 'append', rowIndex, excelRow: rowIndex + 2, quote: q, changes, ...(tmpl ? { origin: 'intake' as const } : {}) })
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
      if (!KK_VENDOR_COLS.some(({ col }) => !isFillableCell(row.cells[col]))) continue
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
  const rows: MasterRow[] = master.rows.map((r) => withCells(r, [...r.cells]))
  for (const action of plan.actions) {
    while (rows.length <= action.rowIndex) {
      rows.push({ cells: Array.from({ length: KK_COL_COUNT }, () => null as MasterCell) })
    }
    // 追加的行：照预建行建的才记成预建行（占用的预编号空行原来带的标记不算）
    if (action.kind === 'append') {
      const cells = rows[action.rowIndex]!.cells
      rows[action.rowIndex] = action.origin ? { cells, origin: action.origin } : { cells }
    }
    const row = rows[action.rowIndex]!
    for (const ch of action.changes) row.cells[ch.col] = ch.to
  }
  return { ...master, rows }
}
