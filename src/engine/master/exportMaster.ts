import ExcelJS from 'exceljs'
import { KK_COL_WIDTHS, KK_HEADERS, KK_STYLE } from '../export/kkLayout'
import { KK_COL_COUNT, type MasterCell, type MasterData } from './model'
import { isMacroEnabledWorkbook, patchMasterWorkbook } from './patchExport'
import { subsetMasterWorkbook } from './subsetExport'

export interface MasterExportOutput {
  buffer: ArrayBuffer
  /** 与内容类型一致的扩展名：macroEnabled 工作簿必须存成 .xlsm，否则 Excel 拒绝打开 */
  extension: 'xlsx' | 'xlsm'
  /** patch=字节级保真；rewrite=exceljs 降级重写（可能丢公式/样式）；fresh=从零重建 */
  mode: 'patch' | 'rewrite' | 'fresh'
}

/**
 * 导出汇总。优先级：
 * 1) zip 级补丁（原文件字节级保真：公式/批注/样式/customXml 全保留，只改动过的单元格）
 * 2) exceljs 以原工作簿为底整本重写（兜底，会丢部分样式与公式）
 * 3) 从零重建（无原文件时）
 */
export async function buildMasterWorkbook(
  master: MasterData,
  originalBuffer: ArrayBuffer | null,
): Promise<MasterExportOutput> {
  if (originalBuffer) {
    try {
      const patched = patchMasterWorkbook(master, originalBuffer)
      if (patched) {
        return {
          buffer: patched.buffer,
          extension: isMacroEnabledWorkbook(originalBuffer) ? 'xlsm' : 'xlsx',
          mode: 'patch',
        }
      }
    } catch {
      // 补丁失败 → 退回 exceljs 重写
    }
    try {
      // exceljs 重写生成的是标准 xlsx 内容类型
      return { buffer: await rewriteOriginal(master, originalBuffer), extension: 'xlsx', mode: 'rewrite' }
    } catch {
      // 原文件加载失败 → 退化为从零重建
    }
  }
  return { buffer: await buildFresh(master), extension: 'xlsx', mode: 'fresh' }
}

export interface MasterSubsetExportOutput {
  buffer: ArrayBuffer
  /** 新生成的工作簿不带宏，一律 .xlsx */
  extension: 'xlsx'
  /** template=以原汇总表为模板（表头/列宽/隐藏列/样式/表格同原表）；fresh=从零重建 */
  mode: 'template' | 'fresh'
  /** 实际导出的行数（去重、去掉越界行之后） */
  rowCount: number
}

/**
 * 只导出总表里的指定行（按给定顺序，重复的只留第一次）：汇总表同样的列和样式，
 * 只有这一张 sheet——NEGO、历史报价等其他 sheet 不带。
 */
export async function buildMasterSubsetWorkbook(
  master: MasterData,
  rowIdxs: readonly number[],
  originalBuffer: ArrayBuffer | null,
): Promise<MasterSubsetExportOutput> {
  const picked = [...new Set(rowIdxs)].filter((i) => master.rows[i] !== undefined)
  if (picked.length === 0) throw new Error('没有可导出的行')
  if (originalBuffer) {
    try {
      const buffer = subsetMasterWorkbook(master, picked, originalBuffer)
      if (buffer) return { buffer, extension: 'xlsx', mode: 'template', rowCount: picked.length }
    } catch {
      // 原表结构认不出 → 从零重建
    }
  }
  const subset: MasterData = { ...master, rows: picked.map((i) => master.rows[i]!), passthrough: [] }
  return { buffer: await buildFresh(subset), extension: 'xlsx', mode: 'fresh', rowCount: picked.length }
}

async function rewriteOriginal(master: MasterData, originalBuffer: ArrayBuffer): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(originalBuffer)
  const ws = wb.getWorksheet(master.sheetName) ?? wb.worksheets[0]
  if (!ws) throw new Error('原工作簿里找不到汇总 sheet')
  const oldRowCount = ws.actualRowCount
  // 原表是旧布局时表头也换成当前布局，保证列名和数据对得上
  const header = ws.getRow(1)
  KK_HEADERS.forEach((h, i) => {
    const cell = header.getCell(i + 1)
    if (cell.value !== h) cell.value = h
  })
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
