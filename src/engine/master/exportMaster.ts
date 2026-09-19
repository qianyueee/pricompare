import ExcelJS from 'exceljs'
import { KK_COL_WIDTHS, KK_HEADERS, KK_STYLE } from '../export/kkLayout'
import { type MasterCell, type MasterData, type PassthroughSheet } from './model'
import { negoSummaryFromInputs, negoTable } from './nego'
import { NEGO_HEADER_ROW, buildNegoSheetSpec, type NegoInput } from './negoSheet'
import { isMacroEnabledWorkbook, patchMasterWorkbook } from './patchExport'

export interface MasterExportOptions {
  /**
   * 比价页当前输入（编号 + 下单数量）：有内容时把工作簿的 NEGO sheet 重建为与比价页同一套逻辑的
   * 公式活表（输入编号/数量自动算单价、最低、总额、最优）并预填这些行；空则 NEGO sheet 原样不动
   */
  negoInputs?: NegoInput[] | null
}

export interface MasterExportOutput {
  buffer: ArrayBuffer
  /** 与内容类型一致的扩展名：macroEnabled 工作簿必须存成 .xlsm，否则 Excel 拒绝打开 */
  extension: 'xlsx' | 'xlsm'
  /** patch=字节级保真；rewrite=exceljs 降级重写（可能丢公式/样式）；fresh=从零重建 */
  mode: 'patch' | 'rewrite' | 'fresh'
  /** 写入 NEGO sheet 的比价行数（0 = 没写：比价页为空或工作簿里没有 NEGO sheet） */
  negoRowsWritten: number
  negoSheetName: string | null
  /** true = 公式活表（补丁路径）；false = 降级路径只写了值表 */
  negoLive: boolean
}

function findNegoSheet(master: MasterData): PassthroughSheet | null {
  return (
    master.passthrough.find((s) => s.name === 'NEGO') ??
    master.passthrough.find((s) => /nego/i.test(s.name)) ??
    null
  )
}

/**
 * 导出汇总。优先级：
 * 1) zip 级补丁（原文件字节级保真：公式/批注/样式/customXml 全保留，只改动过的单元格）——
 *    NEGO sheet 重建为公式活表
 * 2) exceljs 以原工作簿为底整本重写（兜底，会丢部分样式与公式）——NEGO 只写值表
 * 3) 从零重建（无原文件时）——NEGO 只写值表
 */
export async function buildMasterWorkbook(
  master: MasterData,
  originalBuffer: ArrayBuffer | null,
  opts: MasterExportOptions = {},
): Promise<MasterExportOutput> {
  const inputs = (opts.negoInputs ?? []).filter((i) => i.pn.trim() !== '')
  const negoSheet = inputs.length > 0 ? findNegoSheet(master) : null
  if (originalBuffer) {
    try {
      const patched = patchMasterWorkbook(
        master,
        originalBuffer,
        negoSheet ? { nego: { sheetName: negoSheet.name, spec: buildNegoSheetSpec(master, inputs) } } : {},
      )
      if (patched) {
        return {
          buffer: patched.buffer,
          extension: isMacroEnabledWorkbook(originalBuffer) ? 'xlsm' : 'xlsx',
          mode: 'patch',
          negoRowsWritten: patched.negoRows,
          negoSheetName: patched.negoRows > 0 && negoSheet ? negoSheet.name : null,
          negoLive: patched.negoRows > 0,
        }
      }
    } catch {
      // 补丁失败 → 退回 exceljs 重写
    }
    try {
      // exceljs 重写生成的是标准 xlsx 内容类型
      const r = await rewriteOriginal(master, originalBuffer, negoSheet?.name ?? null, inputs)
      return { buffer: r.buffer, extension: 'xlsx', mode: 'rewrite', negoRowsWritten: r.negoRows, negoSheetName: r.negoSheet, negoLive: false }
    } catch {
      // 原文件加载失败 → 退化为从零重建
    }
  }
  const fresh = await buildFresh(master, negoSheet?.name ?? null, inputs)
  return { buffer: fresh.buffer, extension: 'xlsx', mode: 'fresh', negoRowsWritten: fresh.negoRows, negoSheetName: fresh.negoSheet, negoLive: false }
}

/** 降级路径的 NEGO 值表：清空 sheet，第 1 行标题、第 4 行起表头 + 明细 + Total（与「复制为表格」同构） */
function writeNegoValues(ws: ExcelJS.Worksheet, master: MasterData, inputs: NegoInput[]): number {
  const summary = negoSummaryFromInputs(master, inputs)
  if (summary.lines.length === 0) return 0
  try {
    for (const [t] of ws.getTables()) ws.removeTable(t.name)
  } catch {
    // 无表格
  }
  if (ws.rowCount > 0) ws.spliceRows(1, ws.rowCount)
  ws.getCell('B1').value = 'Basis For Negotiation'
  negoTable(summary).forEach((cells, ri) => {
    const r = ws.getRow(NEGO_HEADER_ROW + ri)
    cells.forEach((v, c) => {
      if (v !== null) r.getCell(c + 1).value = v
    })
  })
  return summary.lines.length
}

async function rewriteOriginal(
  master: MasterData,
  originalBuffer: ArrayBuffer,
  negoSheetName: string | null,
  inputs: NegoInput[],
): Promise<{ buffer: ArrayBuffer; negoRows: number; negoSheet: string | null }> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(originalBuffer)
  const ws = wb.getWorksheet(master.sheetName) ?? wb.worksheets[0]
  if (!ws) throw new Error('原工作簿里找不到汇总 sheet')
  const oldRowCount = ws.actualRowCount
  const colCount = master.layout.colCount
  master.rows.forEach((row, i) => {
    const r = ws.getRow(i + 2)
    for (let c = 0; c < colCount; c++) {
      const cell = r.getCell(c + 1)
      const v = row.cells[c] ?? null
      // 保留原样式，仅更新值
      cell.value = v
    }
  })
  // 清掉比当前数据多出来的旧行值（例如删过行后）
  for (let r = master.rows.length + 2; r <= oldRowCount; r++) {
    const row = ws.getRow(r)
    for (let c = 1; c <= colCount; c++) {
      if (row.getCell(c).value !== null) row.getCell(c).value = null
    }
  }
  let negoRows = 0
  let negoSheet: string | null = null
  if (negoSheetName && inputs.length > 0) {
    const nws = wb.getWorksheet(negoSheetName)
    if (nws) {
      negoRows = writeNegoValues(nws, master, inputs)
      negoSheet = negoRows > 0 ? negoSheetName : null
    }
  }
  return { buffer: (await wb.xlsx.writeBuffer()) as ArrayBuffer, negoRows, negoSheet }
}

async function buildFresh(
  master: MasterData,
  negoSheetName: string | null,
  inputs: NegoInput[],
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
  const headers = master.layout.headers.length > 0 ? master.layout.headers : [...KK_HEADERS]
  headers.forEach((h, i) => {
    const cell = header.getCell(i + 1)
    cell.value = h
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: KK_STYLE.headerFill } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = thin
  })
  header.height = 30
  headers.forEach((_, i) => {
    ws.getColumn(i + 1).width = KK_COL_WIDTHS[i] ?? 11
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
    if (negoSheetName && sheet.name === negoSheetName && inputs.length > 0) {
      negoRows = writeNegoValues(pws, master, inputs)
      if (negoRows > 0) {
        negoSheet = sheet.name
        continue
      }
    }
    sheet.grid.forEach((cells, ri) => {
      const r = pws.getRow(ri + 1)
      cells.forEach((v: MasterCell, c: number) => {
        if (v !== null) r.getCell(c + 1).value = v
      })
    })
  }
  // 从零重建且原本没有 NEGO sheet：新建一个放比价内容
  if (!negoSheet && inputs.length > 0) {
    const pws = wb.addWorksheet('NEGO')
    negoRows = writeNegoValues(pws, master, inputs)
    if (negoRows > 0) negoSheet = 'NEGO'
    else wb.removeWorksheet(pws.id)
  }
  return { buffer: (await wb.xlsx.writeBuffer()) as ArrayBuffer, negoRows, negoSheet }
}
