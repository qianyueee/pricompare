import { unzipSync, zipSync } from 'fflate'
import { colLetter } from '../util'
import { readWorkbook } from '../workbook'
import { KK_COL_COUNT, isDataRow, parseMasterWorkbookDetailed, type MasterData } from './model'
import { attrOf, buildCellXml, findSheetPath, parseRowCells, xmlEscape } from './patchExport'
import { quoteEaFor, quoteEaFormula } from './quoteEa'
import { KK_COL } from '../export/kkLayout'

/**
 * 只导出总表里的若干行（主表「导出所选」、比价页「总表格式」）：
 * 以原 KK 汇总表为模板生成一个**只含汇总 sheet** 的新工作簿——
 * 表头行、列宽、隐藏列（O/P/Q/S）、冻结首行、单元格样式、表格（蓝白斑马纹 + 筛选）都沿用原表，
 * 数据只有选中的这几行（值，不带公式：A 列序号等保留总表里的值，方便和总表对照；比价页导出时 U 列例外，见下）。
 * NEGO、历史报价等其他 sheet 不带，批注/图片也不带（它们挂在原表的固定单元格上）。
 *
 * 原表结构认不出（没有表头行、旧布局缺列等）时返回 null，由调用方改用从零重建。
 */

export interface SubsetExportOptions {
  /**
   * U 列 Quote (EA) 写成按 H 列和清洗等级算美元报价的公式（比价页导出用，见 quoteEa.ts）；
   * H 不是数字的行 U 列照总表原样
   */
  quoteEaFormula?: boolean
}

const dec = new TextDecoder()
const enc = new TextEncoder()

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT = {
  workbook: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  sheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  styles: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  sharedStrings: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  table: 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml',
}
const REL_TYPE = `${NS_REL}/`

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

interface Rel {
  type: string
  target: string
}

function readRels(files: Record<string, Uint8Array>, relsPath: string): Rel[] {
  const f = files[relsPath]
  if (!f) return []
  const out: Rel[] = []
  for (const m of dec.decode(f).matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const type = attrOf(m[0], 'Type')
    const target = attrOf(m[0], 'Target')
    if (type && target && attrOf(m[0], 'TargetMode') !== 'External') out.push({ type, target })
  }
  return out
}

/** rels 里的 Target → zip 内路径（相对 baseDir；以 / 开头为包根） */
function resolveTarget(baseDir: string, target: string): string {
  const raw = target.startsWith('/') ? target.slice(1) : `${baseDir}/${target}`
  const parts: string[] = []
  for (const p of raw.split('/')) {
    if (p === '..') parts.pop()
    else if (p !== '.' && p !== '') parts.push(p)
  }
  return parts.join('/')
}

const ROW_RE = /<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g

/** 行开标签里只留行高（ht / customHeight）和行样式，去掉隐藏、分组、spans 等 */
function rowAttrs(rowXml: string): string {
  const open = rowXml.match(/^<row\b[^>]*?\/?>/)?.[0] ?? ''
  let out = ''
  for (const name of ['ht', 'customHeight', 's', 'customFormat']) {
    const v = attrOf(open, name)
    if (v !== null) out += ` ${name}="${v}"`
  }
  return out
}

/** 冻结窗格回到顶部（原表可能停在第 1686 行），去掉旧的选中格 */
function resetSheetViews(head: string): string {
  return head
    .replace(/<sheetView\b[^>]*>/g, (tag) => tag.replace(/\stopLeftCell="[^"]*"/, ''))
    .replace(/<pane\b[^>]*\/>/g, (tag) => {
      const x = Math.max(0, Math.floor(Number(attrOf(tag, 'xSplit') ?? 0)) || 0)
      const y = Math.max(0, Math.floor(Number(attrOf(tag, 'ySplit') ?? 0)) || 0)
      return tag.replace(/\stopLeftCell="[^"]*"/, ` topLeftCell="${colLetter(x)}${y + 1}"`)
    })
    .replace(/<selection\b[^>]*\/>/g, '')
    .replace(/(<sheetPr\b[^>]*?)\sfilterMode="[^"]*"/, '$1')
}

export function subsetMasterWorkbook(
  master: MasterData,
  rowIdxs: readonly number[],
  originalBuffer: ArrayBuffer,
  opts: SubsetExportOptions = {},
): ArrayBuffer | null {
  const files = unzipSync(new Uint8Array(originalBuffer))
  const sheetPath = findSheetPath(files, master.sheetName)
  if (!sheetPath || !files[sheetPath]) return null
  const parsed = parseMasterWorkbookDetailed(readWorkbook(originalBuffer), master.sourceFileName ?? '')
  if (!parsed) return null
  const physCol = parsed.columnMap
  // 旧布局原表缺列（如没有 CL）→ 表头和数据对不上，交给从零重建
  if (physCol.some((p) => p === null || p === undefined)) return null
  const origRows = parsed.master.rows

  const xml = dec.decode(files[sheetPath])
  const sdOpen = xml.match(/<sheetData\b[^>]*>/)
  const sdEnd = xml.indexOf('</sheetData>')
  if (!sdOpen || sdOpen.index === undefined || sdEnd < 0) return null
  const head = xml.slice(0, sdOpen.index)
  const tail = xml.slice(sdEnd + '</sheetData>'.length)

  // 一次扫完原表各行（3 MB 的 sheet 逐行正则查找太慢）
  const rowXmlByNum = new Map<number, string>()
  for (const m of xml.slice(sdOpen.index, sdEnd).matchAll(ROW_RE)) {
    const r = Number(attrOf(m[0].match(/^<row\b[^>]*?\/?>/)![0], 'r'))
    if (Number.isFinite(r) && r <= origRows.length + 1) rowXmlByNum.set(r, m[0])
  }
  const headerXml = rowXmlByNum.get(1)
  if (!headerXml) return null
  const headerCells = parseRowCells(headerXml)
  // 表头用共享字符串时连同 sharedStrings 一起带上（数据格一律写内联字符串）
  const usesSharedStrings = [...headerCells.values()].some((c) => attrOf(c.slice(0, c.indexOf('>') + 1), 't') === 's')

  // 列样式兜底：自底向上扫数据行逐列补齐（和整表导出追加新行时同一规则）
  const colStyle = new Map<number, string>()
  let fallbackRowAttrs = ''
  let scanned = 0
  for (let i = origRows.length - 1; i >= 0 && scanned < 50 && colStyle.size < KK_COL_COUNT; i--) {
    if (!isDataRow(origRows[i]!)) continue
    scanned++
    const rx = rowXmlByNum.get(i + 2)
    if (!rx) continue
    const before = colStyle.size
    for (const [col, cellXml] of parseRowCells(rx)) {
      const s = attrOf(cellXml.slice(0, cellXml.indexOf('>') + 1), 's')
      if (s && !colStyle.has(col)) colStyle.set(col, s)
    }
    if (!fallbackRowAttrs && colStyle.size - before >= 8) fallbackRowAttrs = rowAttrs(rx)
  }

  // 数据行：值取当前总表；样式取原表同一位置的行（与整表导出看到的一致），没有则按列兜底
  const order = [...physCol.entries()].sort((a, b) => a[1]! - b[1]!) as [number, number][]
  const bodyRows: string[] = []
  rowIdxs.forEach((rowIndex, k) => {
    const row = master.rows[rowIndex]
    if (!row) return
    const excelRow = k + 2
    const src = rowIndex < origRows.length ? rowXmlByNum.get(rowIndex + 2) : undefined
    const srcCells = src ? parseRowCells(src) : new Map<number, string>()
    const quoteEa = opts.quoteEaFormula ? quoteEaFor(row.cells) : null
    let body = ''
    for (const [c, p] of order) {
      const v = row.cells[c] ?? null
      const existing = srcCells.get(p)
      // 原表这格存在就照它的样式（没有 s 即默认样式）；不存在才按列兜底
      const s = existing ? attrOf(existing.slice(0, existing.indexOf('>') + 1), 's') : (colStyle.get(p) ?? null)
      const ref = `${colLetter(p)}${excelRow}`
      if (quoteEa && c === KK_COL.quoteEa) {
        // 公式 + 算好的值（不重算的查看器里也显示得出来）
        const f = quoteEaFormula(`${colLetter(physCol[KK_COL.quoteEach]!)}${excelRow}`, quoteEa.multiplier)
        body += `<c r="${ref}"${s ? ` s="${s}"` : ''}><f>${xmlEscape(f)}</f><v>${quoteEa.value}</v></c>`
        continue
      }
      if (v === null && s === null) continue
      body += buildCellXml(ref, s, v)
    }
    bodyRows.push(`<row r="${excelRow}"${src ? rowAttrs(src) : fallbackRowAttrs}>${body}</row>`)
  })
  if (bodyRows.length === 0) return null
  const lastRow = bodyRows.length + 1
  const maxCol = Math.max(...order.map(([, p]) => p), ...headerCells.keys())
  const lastColL = colLetter(maxCol)

  // 表格（KK 模板的斑马纹与筛选来自它）：只带从第 1 行起的那张，范围收缩到导出的行
  const sheetDir = sheetPath.slice(0, sheetPath.lastIndexOf('/'))
  const sheetRelsPath = sheetPath.replace(/([^/]+)\.xml$/, '_rels/$1.xml.rels')
  let tableXml: string | null = null
  for (const rel of readRels(files, sheetRelsPath)) {
    if (rel.type !== `${REL_TYPE}table`) continue
    const tf = files[resolveTarget(sheetDir, rel.target)]
    if (!tf) continue
    const t = dec.decode(tf)
    const open = t.match(/<table\b[^>]*>/)?.[0] ?? ''
    const ref = attrOf(open, 'ref')?.match(/^([A-Z]+)1:([A-Z]+)\d+$/)
    if (!ref || (attrOf(open, 'headerRowCount') ?? '1') !== '1') continue
    const range = `${ref[1]}1:${ref[2]}${lastRow}`
    tableXml = t
      .replace(/<table\b[^>]*>/, (tag) =>
        tag.replace(/(\sref=")[^"]*(")/, `$1${range}$2`).replace(/\stotalsRowCount="[^"]*"/, ''),
      )
      .replace(/<autoFilter\b[^>]*?(?:\/>|>[\s\S]*?<\/autoFilter>)/, `<autoFilter ref="${range}"/>`)
      .replace(/<sortState\b[^>]*?(?:\/>|>[\s\S]*?<\/sortState>)/g, '')
    break
  }

  // 工作表尾部只留打印设置和表格；批注、图片、分页符等挂在原表固定位置上的都不带
  const pick = (re: RegExp) => tail.match(re)?.[0] ?? ''
  const sheetAutoFilter = !tableXml && /<autoFilter\b/.test(tail) ? `<autoFilter ref="A1:${lastColL}${lastRow}"/>` : ''
  const newTail =
    sheetAutoFilter +
    pick(/<printOptions\b[^>]*\/>/) +
    pick(/<pageMargins\b[^>]*\/>/) +
    pick(/<pageSetup\b[^>]*\/>/).replace(/\sr:id="[^"]*"/, '') +
    pick(/<headerFooter\b[^>]*?(?:\/>|>[\s\S]*?<\/headerFooter>)/) +
    (tableXml ? `<tableParts count="1"><tablePart xmlns:r="${NS_REL}" r:id="rId1"/></tableParts>` : '') +
    '</worksheet>'
  if (!/<\/worksheet>\s*$/.test(tail)) return null

  const newHead = resetSheetViews(head).replace(/<dimension\b[^>]*\/>/, `<dimension ref="A1:${lastColL}${lastRow}"/>`)
  const sheetXml = `${newHead}${sdOpen[0]}${headerXml}${bodyRows.join('')}</sheetData>${newTail}`

  // 新工作簿只带这张 sheet：样式、主题（颜色）、表头用到的共享字符串照搬原表
  const wbRels = readRels(files, 'xl/_rels/workbook.xml.rels')
  const partOf = (type: string): Uint8Array | null => {
    const rel = wbRels.find((r) => r.type === `${REL_TYPE}${type}`)
    return rel ? (files[resolveTarget('xl', rel.target)] ?? null) : null
  }
  const styles = partOf('styles')
  if (!styles) return null
  const theme = partOf('theme')
  const sharedStrings = usesSharedStrings ? partOf('sharedStrings') : null
  if (usesSharedStrings && !sharedStrings) return null

  const wbXml = files['xl/workbook.xml'] ? dec.decode(files['xl/workbook.xml']) : ''
  const date1904 = /<workbookPr\b[^>]*\sdate1904="(?:1|true)"/.test(wbXml)

  const out: Record<string, Uint8Array> = {}
  const overrides: [string, string][] = [
    ['/xl/workbook.xml', CT.workbook],
    ['/xl/worksheets/sheet1.xml', CT.sheet],
    ['/xl/styles.xml', CT.styles],
  ]
  const wbRelsOut = [
    `<Relationship Id="rId1" Type="${REL_TYPE}worksheet" Target="worksheets/sheet1.xml"/>`,
    `<Relationship Id="rId2" Type="${REL_TYPE}styles" Target="styles.xml"/>`,
  ]
  out['xl/styles.xml'] = styles
  if (theme) {
    out['xl/theme/theme1.xml'] = theme
    overrides.push(['/xl/theme/theme1.xml', CT.theme])
    wbRelsOut.push(`<Relationship Id="rId3" Type="${REL_TYPE}theme" Target="theme/theme1.xml"/>`)
  }
  if (sharedStrings) {
    out['xl/sharedStrings.xml'] = sharedStrings
    overrides.push(['/xl/sharedStrings.xml', CT.sharedStrings])
    wbRelsOut.push(`<Relationship Id="rId4" Type="${REL_TYPE}sharedStrings" Target="sharedStrings.xml"/>`)
  }
  if (tableXml) {
    out['xl/tables/table1.xml'] = enc.encode(tableXml)
    overrides.push(['/xl/tables/table1.xml', CT.table])
    out['xl/worksheets/_rels/sheet1.xml.rels'] = enc.encode(
      `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${REL_TYPE}table" Target="../tables/table1.xml"/></Relationships>`,
    )
  }
  out['xl/worksheets/sheet1.xml'] = enc.encode(sheetXml)
  out['xl/workbook.xml'] = enc.encode(
    `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
      (date1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>') +
      '<bookViews><workbookView activeTab="0"/></bookViews>' +
      `<sheets><sheet name="${xmlEscape(master.sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
      '</workbook>',
  )
  out['xl/_rels/workbook.xml.rels'] = enc.encode(
    `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">${wbRelsOut.join('')}</Relationships>`,
  )
  out['_rels/.rels'] = enc.encode(
    `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${REL_TYPE}officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  )
  out['[Content_Types].xml'] = enc.encode(
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('') +
      '</Types>',
  )
  const zipped = zipSync(out, { level: 6 })
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
}
