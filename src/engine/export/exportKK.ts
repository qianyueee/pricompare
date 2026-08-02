import ExcelJS from 'exceljs'
import { formatLeadTime } from '../normalize/leadtime'
import { letterToIdx } from '../util'
import type { CompareCell, CompareResult, CompareRow, QuoteRow } from '../types'
import type { Vendor } from '../vendor'
import { KK_COL, KK_COL_WIDTHS, KK_HEADERS, KK_SHEET_NAME, KK_STYLE } from './kkLayout'

export interface KkExportOptions {
  /** 写入 B 列 Name 的汇总名称（如 "20260802 询价"） */
  batchName: string
  usdRate: number
  /** 供应商注册表，用于取 KK 模板传统槽位（hc→J、skw→K…） */
  registry: Vendor[]
  /** vendorId → 显示名 */
  displayNames: Record<string, string>
}

export interface KkExportOutput {
  buffer: ArrayBuffer
  warnings: string[]
  /** vendorId → 最终 0 基列号（供测试与界面提示） */
  slotByVendor: Record<string, number>
  /** 最终表头（含插入列） */
  headers: string[]
}

interface SlotPlan {
  headers: string[]
  slotByVendor: Record<string, number>
  /** N 列之后插入的列数；基准列号 ≥ O 的都要加上它 */
  insertedAfterN: number
  usdVendors: Set<string>
  warnings: string[]
}

/** 该供应商是否按美元报价（多数 ok 报价为 USD） */
function isUsdVendor(result: CompareResult, vendorId: string): boolean {
  let usd = 0
  let rmb = 0
  for (const row of result.rows) {
    const c = row.cells[vendorId]
    if (!c || c.price.status !== 'ok') continue
    if (c.price.currency === 'USD') usd++
    else rmb++
  }
  return usd > rmb
}

/**
 * 供应商落列规划：
 * 已知槽位（registry.kkSlot）落传统列；未知人民币供应商占 I–N 最左空槽并改写表头；
 * 第一家美元供应商落 O 列（保留模板表头）；超员在 N 后插入新列并给出警告。
 */
export function planSlots(result: CompareResult, opts: KkExportOptions): SlotPlan {
  const headers = [...KK_HEADERS]
  const slotByVendor: Record<string, number> = {}
  const warnings: string[] = []
  const usdVendors = new Set<string>()
  const slotUsed = new Set<number>()
  const inserted: { vendorId: string; header: string }[] = []

  const display = (id: string): string => opts.displayNames[id] ?? id

  const rmbVendors: string[] = []
  for (const v of result.vendors) {
    if (isUsdVendor(result, v.vendorId)) usdVendors.add(v.vendorId)
    else rmbVendors.push(v.vendorId)
  }

  // 1) 已知槽位优先
  for (const vendorId of rmbVendors) {
    const reg = opts.registry.find((r) => r.id === vendorId)
    if (!reg?.kkSlot) continue
    const idx = letterToIdx(reg.kkSlot)
    if (idx >= KK_COL.vendorSlotStart && idx <= KK_COL.vendorSlotEnd && !slotUsed.has(idx)) {
      slotUsed.add(idx)
      slotByVendor[vendorId] = idx
    }
  }
  // 2) 其余人民币供应商占最左空槽，表头改为供应商名
  for (const vendorId of rmbVendors) {
    if (slotByVendor[vendorId] !== undefined) continue
    let placed = false
    for (let idx = KK_COL.vendorSlotStart; idx <= KK_COL.vendorSlotEnd; idx++) {
      if (slotUsed.has(idx)) continue
      slotUsed.add(idx)
      slotByVendor[vendorId] = idx
      headers[idx] = display(vendorId)
      placed = true
      break
    }
    if (!placed) inserted.push({ vendorId, header: display(vendorId) })
  }
  // 3) 美元供应商：第一家落 O 列，其余插入
  let usdSlotTaken = false
  for (const vendorId of usdVendors) {
    if (!usdSlotTaken) {
      usdSlotTaken = true
      slotByVendor[vendorId] = KK_COL.usVendor // 基准列号，稍后统一位移
    } else {
      inserted.push({ vendorId, header: `${display(vendorId)} (US$)` })
    }
  }
  // 4) N 列后插入超员列
  if (inserted.length > 0) {
    headers.splice(KK_COL.vendorSlotEnd + 1, 0, ...inserted.map((i) => i.header))
    warnings.push(
      `供应商超出模板 I–N 槽位，已在 N 列后插入新列：${inserted.map((i) => i.header).join('、')}`,
    )
  }
  const shift = inserted.length
  for (const [vendorId, idx] of Object.entries(slotByVendor)) {
    if (idx > KK_COL.vendorSlotEnd) slotByVendor[vendorId] = idx + shift
  }
  inserted.forEach((ins, i) => {
    slotByVendor[ins.vendorId] = KK_COL.vendorSlotEnd + 1 + i
  })
  return { headers, slotByVendor, insertedAfterN: shift, usdVendors, warnings }
}

/** 位移后的基准列号（O 列及之后 + 插入数） */
function shifted(base: number, plan: SlotPlan): number {
  return base > KK_COL.vendorSlotEnd ? base + plan.insertedAfterN : base
}

/** 该行的主来源（最低价供应商优先），供 X–AG 明细列取值 */
function primarySource(row: CompareRow, slotOrder: string[]): QuoteRow | undefined {
  let minSource: QuoteRow | undefined
  for (const vendorId of slotOrder) {
    const c = row.cells[vendorId]
    if (c && c.rmbEquivalent !== null && c.rmbEquivalent === row.minRmb) {
      minSource = c.source
      break
    }
  }
  if (minSource) return minSource
  for (const vendorId of slotOrder) {
    const c = row.cells[vendorId]
    if (c) return c.source
  }
  return undefined
}

function pickField(row: CompareRow, slotOrder: string[], get: (q: QuoteRow) => string): string {
  const primary = primarySource(row, slotOrder)
  if (primary) {
    const v = get(primary)
    if (v) return v
  }
  for (const vendorId of slotOrder) {
    const c = row.cells[vendorId]
    if (c) {
      const v = get(c.source)
      if (v) return v
    }
  }
  return ''
}

export async function buildKkWorkbook(
  result: CompareResult,
  opts: KkExportOptions,
): Promise<KkExportOutput> {
  const plan = planSlots(result, opts)
  const wb = new ExcelJS.Workbook()
  wb.created = new Date()
  const ws = wb.addWorksheet(KK_SHEET_NAME, {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  const totalCols = plan.headers.length
  const thin = {
    top: { style: 'thin' as const, color: { argb: KK_STYLE.borderColor } },
    left: { style: 'thin' as const, color: { argb: KK_STYLE.borderColor } },
    bottom: { style: 'thin' as const, color: { argb: KK_STYLE.borderColor } },
    right: { style: 'thin' as const, color: { argb: KK_STYLE.borderColor } },
  }

  // 表头
  const headerRow = ws.getRow(1)
  plan.headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = h
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: KK_STYLE.headerFill } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = thin
  })
  headerRow.height = 30

  // 列宽
  for (let i = 0; i < totalCols; i++) {
    const baseIdx =
      i <= KK_COL.vendorSlotEnd
        ? i
        : i <= KK_COL.vendorSlotEnd + plan.insertedAfterN
          ? KK_COL.vendorSlotStart // 插入列按供应商列宽
          : i - plan.insertedAfterN
    ws.getColumn(i + 1).width = KK_COL_WIDTHS[baseIdx] ?? 11
  }

  // 供应商列序（按最终列号升序），用于 V/W 拼接与明细取值
  const slotOrder = Object.entries(plan.slotByVendor)
    .sort((a, b) => a[1] - b[1])
    .map(([vendorId]) => vendorId)

  result.rows.forEach((row, i) => {
    const r = ws.getRow(i + 2)
    const set = (baseCol: number, value: ExcelJS.CellValue): ExcelJS.Cell => {
      const cell = r.getCell(shifted(baseCol, plan) + 1)
      cell.value = value
      return cell
    }
    set(KK_COL.no, i + 1)
    set(KK_COL.name, opts.batchName)
    set(KK_COL.item, i + 1)
    set(KK_COL.pn, row.pn)
    set(KK_COL.rev, row.rev)
    set(KK_COL.description, row.description)
    set(KK_COL.qty, row.qty ?? '')

    // 各供应商价格
    for (const vendorId of slotOrder) {
      const c: CompareCell | undefined = row.cells[vendorId]
      if (!c) continue
      const colIdx = plan.slotByVendor[vendorId]!
      const cell = r.getCell(colIdx + 1)
      if (c.price.status === 'ok' && c.price.amount !== undefined) {
        cell.value = c.price.amount
        cell.numFmt = '#,##0.00'
        if (c.isMin) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: KK_STYLE.minFill } }
          cell.font = { color: { argb: KK_STYLE.minFont } }
        }
      } else if (c.price.status === 'pending') {
        cell.value = 'TDB'
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: KK_STYLE.pendingFill } }
        cell.font = { color: { argb: KK_STYLE.pendingFont } }
      }
    }

    // H = 选定价（默认最低人民币等值）；P = H / 汇率
    if (row.minRmb !== null) {
      const h = set(KK_COL.quoteEach, row.minRmb)
      h.numFmt = '#,##0.00'
      const p = set(KK_COL.usd, Math.round((row.minRmb / opts.usdRate) * 100) / 100)
      p.numFmt = '0.00'
    } else {
      const anyPending = Object.values(row.cells).some((c) => c?.price.status === 'pending')
      if (anyPending) set(KK_COL.quoteEach, 'TDB')
    }

    // V = 各家报价单号 '/' 拼接；W = 各家交期原文 '/' 拼接（按列序）
    const quoteNos: string[] = []
    const leadTimes: string[] = []
    for (const vendorId of slotOrder) {
      const c = row.cells[vendorId]
      if (!c) continue
      if (c.source.quoteNo && !quoteNos.includes(c.source.quoteNo)) quoteNos.push(c.source.quoteNo)
      if (c.leadTime.raw) leadTimes.push(formatLeadTime(c.leadTime))
    }
    if (quoteNos.length > 0) set(KK_COL.quoteNo, quoteNos.join('/'))
    if (leadTimes.length > 0) set(KK_COL.leadTime, leadTimes.join('/'))

    set(KK_COL.material, pickField(row, slotOrder, (q) => q.material))
    set(KK_COL.surfaceFinish, pickField(row, slotOrder, (q) => q.surfaceFinish))
    set(KK_COL.cleaningSpec, pickField(row, slotOrder, (q) => q.cleaningSpec))
    set(KK_COL.process, pickField(row, slotOrder, (q) => q.process))
    set(KK_COL.size, pickField(row, slotOrder, (q) => q.size))
    set(KK_COL.partType, pickField(row, slotOrder, (q) => q.partType))
    set(KK_COL.comment, pickField(row, slotOrder, (q) => q.remark))
    set(KK_COL.basePn, pickField(row, slotOrder, (q) => q.basePn))

    // 数据区边框
    for (let c = 1; c <= totalCols; c++) r.getCell(c).border = thin
  })

  const buffer = (await wb.xlsx.writeBuffer()) as ArrayBuffer
  return { buffer, warnings: plan.warnings, slotByVendor: plan.slotByVendor, headers: plan.headers }
}
