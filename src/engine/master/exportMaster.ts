import ExcelJS from 'exceljs'
import { KK_COL_WIDTHS, KK_HEADERS, KK_STYLE } from '../export/kkLayout'
import { KK_COL_COUNT, type MasterCell, type MasterData } from './model'
import { patchMasterWorkbook } from './patchExport'

/**
 * 导出汇总。优先级：
 * 1) zip 级补丁（原文件字节级保真：公式/批注/样式/customXml 全保留，只改动过的单元格）
 * 2) exceljs 以原工作簿为底整本重写（兜底，会丢部分样式与公式）
 * 3) 从零重建（无原文件时）
 */
export async function buildMasterWorkbook(
  master: MasterData,
  originalBuffer: ArrayBuffer | null,
): Promise<ArrayBuffer> {
  if (originalBuffer) {
    try {
      const patched = patchMasterWorkbook(master, originalBuffer)
      if (patched) return patched.buffer
    } catch {
      // 补丁失败 → 退回 exceljs 重写
    }
    try {
      return await rewriteOriginal(master, originalBuffer)
    } catch {
      // 原文件加载失败 → 退化为从零重建
    }
  }
  return buildFresh(master)
}

async function rewriteOriginal(master: MasterData, originalBuffer: ArrayBuffer): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(originalBuffer)
  const ws = wb.getWorksheet(master.sheetName) ?? wb.worksheets[0]
  if (!ws) throw new Error('原工作簿里找不到汇总 sheet')
  const oldRowCount = ws.actualRowCount
  master.rows.forEach((row, i) => {
    const r = ws.getRow(i + 2)
    for (let c = 0; c < KK_COL_COUNT; c++) {
      const cell = r.getCell(c + 1)
      const v = row.cells[c] ?? null
      // 保留原样式，仅更新值
      cell.value = v
    }
  })
  // 清掉比当前数据多出来的旧行值（例如删过行后）
  for (let r = master.rows.length + 2; r <= oldRowCount; r++) {
    const row = ws.getRow(r)
    for (let c = 1; c <= KK_COL_COUNT; c++) {
      if (row.getCell(c).value !== null) row.getCell(c).value = null
    }
  }
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer
}

async function buildFresh(master: MasterData): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(master.sheetName || 'KK询价汇总', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })
  const thin = {
    top: { style: 'thin' as const, color: { argb: KK_STYLE.borderColor } },
    left: { style: 'thin' as const, color: { argb: KK_STYLE.borderColor } },
    bottom: { style: 'thin' as const, color: { argb: KK_STYLE.borderColor } },
    right: { style: 'thin' as const, color: { argb: KK_STYLE.borderColor } },
  }
  const header = ws.getRow(1)
  KK_HEADERS.forEach((h, i) => {
    const cell = header.getCell(i + 1)
    cell.value = h
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: KK_STYLE.headerFill } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = thin
  })
  header.height = 30
  KK_COL_WIDTHS.forEach((w, i) => {
    ws.getColumn(i + 1).width = w
  })
  master.rows.forEach((row, i) => {
    const r = ws.getRow(i + 2)
    row.cells.forEach((v, c) => {
      if (v !== null) r.getCell(c + 1).value = v
    })
  })
  for (const sheet of master.passthrough) {
    const pws = wb.addWorksheet(sheet.name)
    sheet.grid.forEach((cells, ri) => {
      const r = pws.getRow(ri + 1)
      cells.forEach((v: MasterCell, c: number) => {
        if (v !== null) r.getCell(c + 1).value = v
      })
    })
  }
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer
}
