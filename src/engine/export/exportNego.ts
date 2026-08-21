import ExcelJS from 'exceljs'
import { KK_STYLE } from './kkLayout'
import type { NegoSummary } from '../master/nego'

/**
 * 比价页「导出表格」：NEGO sheet 同构布局的独立工作簿——
 * P/N | Rev | Description | Q'ty | 各家 Unit (RMB) | Min (RMB) | 各家 Total (RMB) | Optimal (RMB)，
 * 最低单价与最优列绿色高亮，底部 Total 合计行。表内全英文（对外可直接转发）。
 */
export async function buildNegoWorkbook(summary: NegoSummary): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('NEGO', { views: [{ state: 'frozen', ySplit: 1 }] })
  const vendors = summary.vendors
  const headers = [
    'P/N',
    'Rev',
    'Description',
    "Q'ty",
    ...vendors.map((v) => `${v.label} Unit (RMB)`),
    'Min (RMB)',
    ...vendors.map((v) => `${v.label} Total (RMB)`),
    'Optimal (RMB)',
  ]
  const widths = [16, 7, 36, 8, ...vendors.map(() => 14), 12, ...vendors.map(() => 14), 14]
  const thin = { style: 'thin' as const, color: { argb: KK_STYLE.borderColor } }
  const border = { top: thin, left: thin, bottom: thin, right: thin }
  const greenFill = {
    type: 'pattern' as const,
    pattern: 'solid' as const,
    fgColor: { argb: KK_STYLE.minFill },
  }

  const hr = ws.getRow(1)
  headers.forEach((h, i) => {
    const c = hr.getCell(i + 1)
    c.value = h
    c.font = { bold: true }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: KK_STYLE.headerFill } }
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    c.border = border
  })
  hr.height = 28
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w
  })

  const unitStart = 4 // 0 基：各家单价列起点
  const minIdx = unitStart + vendors.length
  const optimalIdx = headers.length - 1
  summary.lines.forEach((l, i) => {
    const r = ws.getRow(2 + i)
    const vals: (string | number | null)[] = [
      l.pn,
      l.rev,
      l.description,
      l.qty,
      ...vendors.map((v) => l.unit[v.slot] ?? null),
      l.minUnit,
      ...vendors.map((v) => l.totals[v.slot] ?? null),
      l.optimalTotal,
    ]
    vals.forEach((v, ci) => {
      const c = r.getCell(ci + 1)
      if (v !== null && v !== undefined) c.value = v
      c.border = border
      const isMinUnit =
        ci >= unitStart && ci < unitStart + vendors.length && v !== null && l.minUnit !== null && v === l.minUnit
      if ((isMinUnit || ci === minIdx || ci === optimalIdx) && v !== null) {
        c.fill = greenFill
        c.font = { color: { argb: KK_STYLE.minFont }, bold: ci !== minIdx ? false : true }
      }
    })
  })

  // 合计行（表内不出现中文 → Total）
  const tr = ws.getRow(2 + summary.lines.length)
  tr.getCell(1).value = 'Total'
  for (let ci = 0; ci < headers.length; ci++) tr.getCell(ci + 1).border = border
  summary.perVendor.forEach((v, i) => {
    const c = tr.getCell(minIdx + 2 + i)
    c.value = v.sum
    c.font = { bold: true }
  })
  const oc = tr.getCell(optimalIdx + 1)
  oc.value = summary.optimalSum
  oc.fill = greenFill
  oc.font = { bold: true, color: { argb: KK_STYLE.minFont } }
  tr.getCell(1).font = { bold: true }

  return (await wb.xlsx.writeBuffer()) as ArrayBuffer
}
