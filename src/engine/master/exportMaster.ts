import ExcelJS from 'exceljs'
import { KK_COL_WIDTHS, KK_HEADERS, KK_STYLE } from '../export/kkLayout'
import { KK_COL_COUNT, type MasterCell, type MasterData, type PassthroughSheet } from './model'
import { negoTable, planNegoSheetWrite, type NegoSummary } from './nego'
import { isMacroEnabledWorkbook, patchMasterWorkbook } from './patchExport'

export interface MasterExportOptions {
  /** 比价页当前内容：有明细时写入 NEGO sheet（与「复制为表格」同构布局，自动定位表头行） */
  nego?: NegoSummary | null
}

export interface MasterExportOutput {
  buffer: ArrayBuffer
  /** 与内容类型一致的扩展名：macroEnabled 工作簿必须存成 .xlsm，否则 Excel 拒绝打开 */
  extension: 'xlsx' | 'xlsm'
  /** patch=字节级保真；rewrite=exceljs 降级重写（可能丢公式/样式）；fresh=从零重建 */
  mode: 'patch' | 'rewrite' | 'fresh'
  /** 写入 NEGO sheet 的比价明细行数（0 = 没写：比价页为空或工作簿里没有 NEGO sheet） */
  negoRowsWritten: number
  negoSheetName: string | null
}

/** 0 基 (行 → 列 → 值) 的 NEGO 写入集 */
interface NegoWrite {
  sheetName: string
  writes: Map<number, Map<number, MasterCell>>
  lineCount: number
}

function findNegoSheet(master: MasterData): PassthroughSheet | null {
  return (
    master.passthrough.find((s) => s.name === 'NEGO') ??
    master.passthrough.find((s) => /nego/i.test(s.name)) ??
    null
  )
}

function resolveNegoWrite(master: MasterData, nego: NegoSummary | null): NegoWrite | null {
  if (!nego || nego.lines.length === 0) return null
  const sheet = findNegoSheet(master)
  if (!sheet) return null
  const plan = planNegoSheetWrite(sheet.grid, nego)
  return { sheetName: sheet.name, writes: plan.writes, lineCount: plan.lineCount }
}

/**
 * 导出汇总。优先级：
 * 1) zip 级补丁（原文件字节级保真：公式/批注/样式/customXml 全保留，只改动过的单元格）
 * 2) exceljs 以原工作簿为底整本重写（兜底，会丢部分样式与公式）
 * 3) 从零重建（无原文件时）
 * 三条路径都会把比价页内容写进 NEGO sheet（有明细时）。
 */
export async function buildMasterWorkbook(
  master: MasterData,
  originalBuffer: ArrayBuffer | null,
  opts: MasterExportOptions = {},
): Promise<MasterExportOutput> {
  const negoSummary = opts.nego ?? null
  const nego = resolveNegoWrite(master, negoSummary)
  const negoOut = nego
    ? { negoRowsWritten: nego.lineCount, negoSheetName: nego.sheetName }
    : { negoRowsWritten: 0, negoSheetName: null }
  if (originalBuffer) {
    try {
      const patched = patchMasterWorkbook(
        master,
        originalBuffer,
        nego ? [{ sheetName: nego.sheetName, changes: new Map([...nego.writes].map(([r, m]) => [r + 1, m])) }] : [],
      )
      if (patched) {
        return {
          buffer: patched.buffer,
          extension: isMacroEnabledWorkbook(originalBuffer) ? 'xlsm' : 'xlsx',
          mode: 'patch',
          ...negoOut,
        }
      }
    } catch {
      // 补丁失败 → 退回 exceljs 重写
    }
    try {
      // exceljs 重写生成的是标准 xlsx 内容类型
      return { buffer: await rewriteOriginal(master, originalBuffer, nego), extension: 'xlsx', mode: 'rewrite', ...negoOut }
    } catch {
      // 原文件加载失败 → 退化为从零重建
    }
  }
  const fresh = await buildFresh(master, nego, negoSummary)
  return { buffer: fresh.buffer, extension: 'xlsx', mode: 'fresh', negoRowsWritten: fresh.negoRows, negoSheetName: fresh.negoSheet }
}

async function rewriteOriginal(master: MasterData, originalBuffer: ArrayBuffer, nego: NegoWrite | null): Promise<ArrayBuffer> {
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
  if (nego) {
    const nws = wb.getWorksheet(nego.sheetName)
    if (nws) {
      for (const [r, m] of nego.writes) for (const [c, v] of m) nws.getRow(r + 1).getCell(c + 1).value = v
    }
  }
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer
}

async function buildFresh(
  master: MasterData,
  nego: NegoWrite | null,
  negoSummary: NegoSummary | null,
): Promise<{ buffer: ArrayBuffer; negoRows: number; negoSheet: string | null }> {
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
  let negoRows = 0
  let negoSheet: string | null = null
  for (const sheet of master.passthrough) {
    const pws = wb.addWorksheet(sheet.name)
    sheet.grid.forEach((cells, ri) => {
      const r = pws.getRow(ri + 1)
      cells.forEach((v: MasterCell, c: number) => {
        if (v !== null) r.getCell(c + 1).value = v
      })
    })
    if (nego && sheet.name === nego.sheetName) {
      for (const [r, m] of nego.writes) for (const [c, v] of m) pws.getRow(r + 1).getCell(c + 1).value = v
      negoRows = nego.lineCount
      negoSheet = sheet.name
    }
  }
  // 从零重建且原本没有 NEGO sheet：新建一个放比价内容
  if (!nego && negoSummary && negoSummary.lines.length > 0) {
    const pws = wb.addWorksheet('NEGO')
    negoTable(negoSummary).forEach((cells, ri) => {
      const r = pws.getRow(ri + 1)
      cells.forEach((v, c) => {
        if (v !== null) r.getCell(c + 1).value = v
      })
    })
    negoRows = negoSummary.lines.length
    negoSheet = 'NEGO'
  }
  return { buffer: (await wb.xlsx.writeBuffer()) as ArrayBuffer, negoRows, negoSheet }
}
