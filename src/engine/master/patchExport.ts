import { unzipSync, zipSync } from 'fflate'
import { colLetter } from '../util'
import { readWorkbook } from '../workbook'
import { KK_COL_COUNT, isDataRow, parseMasterWorkbook, type MasterCell, type MasterData } from './model'

/**
 * zip 级"外科手术"导出：原工作簿每个字节原样保留，只把【确实改过的单元格】
 * 打补丁进汇总 sheet 的 XML。公式（A 列共享公式、AF 列表格公式）、批注、
 * 样式、条件格式、customXml、打印设置全部不受影响 —— 这是 exceljs 整本重写
 * 做不到的（实测会丢 3/4 样式、4 条批注、415 个公式）。
 */

const dec = new TextDecoder()
const enc = new TextEncoder()

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function attrOf(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))
  return m ? m[1]! : null
}

/** 在 workbook.xml + rels 里找到汇总 sheet 对应的 part 路径 */
function findSheetPath(files: Record<string, Uint8Array>, sheetName: string): string | null {
  const wb = files['xl/workbook.xml']
  const rels = files['xl/_rels/workbook.xml.rels']
  if (!wb || !rels) return null
  let rid: string | null = null
  for (const m of dec.decode(wb).matchAll(/<sheet\b[^>]*\/?>/g)) {
    const tag = m[0]
    const name = attrOf(tag, 'name')
    if (name !== null && xmlUnescape(name) === sheetName) {
      rid = attrOf(tag, 'r:id')
      break
    }
  }
  if (!rid) return null
  for (const m of dec.decode(rels).matchAll(/<Relationship\b[^>]*\/?>/g)) {
    if (attrOf(m[0], 'Id') === rid) {
      const target = attrOf(m[0], 'Target')
      if (!target) return null
      return target.startsWith('/') ? target.slice(1) : `xl/${target}`
    }
  }
  return null
}

function buildCellXml(ref: string, s: string | null, v: MasterCell): string {
  const sAttr = s ? ` s="${s}"` : ''
  if (v === null) return `<c r="${ref}"${sAttr}/>`
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${sAttr}><v>${v}</v></c>`
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(v))}</t></is></c>`
}

function colIdxOfRef(ref: string): number {
  let n = 0
  for (const ch of ref) {
    if (ch >= '0' && ch <= '9') break
    n = n * 26 + (ch.charCodeAt(0) - 64)
  }
  return n - 1
}

const CELL_RE = /<c\b[^>]*?r="[A-Z]+\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g

/** 取某一行现有单元格的 col → 完整 XML 映射 */
function parseRowCells(rowXml: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const m of rowXml.matchAll(CELL_RE)) {
    const ref = attrOf(m[0].slice(0, m[0].indexOf('>') + 1), 'r') ?? ''
    if (ref) out.set(colIdxOfRef(ref), m[0])
  }
  return out
}

export interface PatchResult {
  buffer: ArrayBuffer
  changedCells: number
  formulaCellsReplaced: number
  /** 额外 sheet（如 NEGO）写入的单元格数 */
  extraCells: number
}

/** 汇总以外的 sheet 补丁：Excel 1 基行号 → 0 基列 → 值（null = 清空） */
export interface ExtraSheetPatch {
  sheetName: string
  changes: Map<number, Map<number, MasterCell>>
}

/**
 * 工作簿内容类型是否为"启用宏"（.xlsm 专用）。补丁导出保留原字节，
 * 扩展名必须与内容类型一致，否则 Excel 报"文件格式或扩展名无效"拒绝打开。
 */
export function isMacroEnabledWorkbook(buffer: ArrayBuffer): boolean {
  try {
    const files = unzipSync(new Uint8Array(buffer))
    const ct = files['[Content_Types].xml']
    return ct ? dec.decode(ct).includes('macroEnabled.main') : false
  } catch {
    return false
  }
}

/**
 * 把 (Excel 行号 → 列 → 值) 变更集打进 sheet XML：已有行只替换/补入目标格（沿用原样式 s），
 * 不存在的行按行号顺序插入（sheetData 内行必须升序，NEGO 这类稀疏 sheet 尤其如此）。
 */
function applyRowChanges(
  xml: string,
  changes: Map<number, Map<number, MasterCell>>,
  colStyle: Map<number, string>,
  styleRowAttrs: string,
): { xml: string; formulaCellsReplaced: number } {
  let formulaCellsReplaced = 0
  const sortedRows = [...changes.entries()].sort((x, y) => x[0] - y[0])
  for (const [excelRow, rowMap] of sortedRows) {
    const rowRe = new RegExp(`<row r="${excelRow}"[^>]*(?:/>|>[\\s\\S]*?</row>)`)
    const m = xml.match(rowRe)
    if (m) {
      const rowXml = m[0]
      const selfClosing = /\/>$/.test(rowXml) && !rowXml.includes('</row>')
      let openTag = rowXml.match(/^<row\b[^>]*?\/?>/)![0]
      if (selfClosing) openTag = `${openTag.slice(0, -2)}>`
      const cells = selfClosing ? new Map<number, string>() : parseRowCells(rowXml)
      for (const [col, val] of rowMap) {
        const ref = `${colLetter(col)}${excelRow}`
        const existing = cells.get(col)
        let s: string | null = colStyle.get(col) ?? null
        if (existing) {
          const cellOpen = existing.slice(0, existing.indexOf('>') + 1)
          s = attrOf(cellOpen, 's') ?? s
          if (/<f[\s>/]/.test(existing)) formulaCellsReplaced++
        }
        cells.set(col, buildCellXml(ref, s, val))
      }
      const body = [...cells.entries()].sort((x, y) => x[0] - y[0]).map(([, c]) => c).join('')
      xml = xml.replace(rowXml, `${openTag}${body}</row>`)
    } else {
      const body = [...rowMap.entries()]
        .sort((x, y) => x[0] - y[0])
        .map(([col, val]) => buildCellXml(`${colLetter(col)}${excelRow}`, colStyle.get(col) ?? null, val))
        .join('')
      const rowXmlNew = `<row r="${excelRow}"${styleRowAttrs}>${body}</row>`
      let inserted = false
      for (const rm of xml.matchAll(/<row r="(\d+)"/g)) {
        if (Number(rm[1]) > excelRow) {
          xml = xml.slice(0, rm.index!) + rowXmlNew + xml.slice(rm.index!)
          inserted = true
          break
        }
      }
      if (!inserted) {
        if (xml.includes('</sheetData>')) xml = xml.replace('</sheetData>', `${rowXmlNew}</sheetData>`)
        else xml = xml.replace('<sheetData/>', `<sheetData>${rowXmlNew}</sheetData>`)
      }
    }
  }
  return { xml, formulaCellsReplaced }
}

/** dimension 底部同步到新底部（Excel 容忍旧值，但保持一致更干净） */
function bumpDimension(xml: string, newBottom: number): string {
  return xml.replace(
    /(<dimension ref="[A-Z]+\d+:[A-Z]+)(\d+)("\/>)/,
    (all, p1: string, bottom: string, p3: string) => (Number(bottom) < newBottom ? `${p1}${newBottom}${p3}` : all),
  )
}

export function patchMasterWorkbook(
  master: MasterData,
  originalBuffer: ArrayBuffer,
  extraSheets: ExtraSheetPatch[] = [],
): PatchResult | null {
  const files = unzipSync(new Uint8Array(originalBuffer))
  const sheetPath = findSheetPath(files, master.sheetName)
  if (!sheetPath || !files[sheetPath]) return null
  const originalMaster = parseMasterWorkbook(readWorkbook(originalBuffer), master.sourceFileName ?? '')
  if (!originalMaster) return null
  const origRows = originalMaster.rows

  // 变更集（与导入时同一条解析管线比对，未动的单元格绝不触碰）
  const norm = (v: MasterCell | undefined): MasterCell =>
    v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? null : v
  const changes = new Map<number, Map<number, MasterCell>>()
  let changedCells = 0
  const maxLen = Math.max(master.rows.length, origRows.length)
  for (let i = 0; i < maxLen; i++) {
    const cur = master.rows[i]
    const orig = origRows[i]
    for (let c = 0; c < KK_COL_COUNT; c++) {
      const a = norm(orig?.cells[c])
      const b = norm(cur?.cells[c])
      if (a === b) continue
      if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9) continue
      if (a !== null && b !== null && String(a) === String(b)) continue
      let rowMap = changes.get(i + 2)
      if (!rowMap) {
        rowMap = new Map()
        changes.set(i + 2, rowMap)
      }
      rowMap.set(c, b)
      changedCells++
    }
  }
  const extras = extraSheets.filter((e) => e.changes.size > 0)
  if (changedCells === 0 && extras.length === 0) {
    return { buffer: originalBuffer.slice(0), changedCells: 0, formulaCellsReplaced: 0, extraCells: 0 }
  }

  let formulaCellsReplaced = 0
  if (changedCells > 0) {
    let xml = dec.decode(files[sheetPath])

    // 新单元格的列样式参考：自底向上扫描数据行、逐列补齐（最多 50 行）。
    // 不能只取最后一行——手工加过的行可能残缺（只有零星几格带样式），
    // 会让新增行大面积落回默认字体（实测：等线 11 vs 模板 Arial 14）
    const colStyle = new Map<number, string>()
    let styleRowAttrs = '' // 追加全新行时沿用的行属性（ht/customHeight）
    let scanned = 0
    for (let i = origRows.length - 1; i >= 0 && scanned < 50 && colStyle.size < KK_COL_COUNT; i--) {
      if (!isDataRow(origRows[i]!)) continue
      scanned++
      const m = xml.match(new RegExp(`<row r="${i + 2}"[^>]*(?:/>|>[\\s\\S]*?</row>)`))
      if (!m) continue
      const before = colStyle.size
      for (const [col, cellXml] of parseRowCells(m[0])) {
        const openTag = cellXml.slice(0, cellXml.indexOf('>') + 1)
        const s = attrOf(openTag, 's')
        if (s && !colStyle.has(col)) colStyle.set(col, s)
      }
      if (!styleRowAttrs && colStyle.size - before >= 8) {
        const open = m[0].match(/^<row\b[^>]*?\/?>/)![0]
        const ht = open.match(/\sht="[^"]*"/)?.[0] ?? ''
        const ch = open.match(/\scustomHeight="[^"]*"/)?.[0] ?? ''
        styleRowAttrs = `${ht}${ch}`
      }
    }

    const applied = applyRowChanges(xml, changes, colStyle, styleRowAttrs)
    xml = applied.xml
    formulaCellsReplaced += applied.formulaCellsReplaced

    // 追加行超出原底部时：扩展该 sheet 上的 Excel 表格（Table）ref/autoFilter 到新底部行——
    // KK 模板的蓝白带状样式（row stripes）与筛选来自表格范围，不扩展则新增行没有斑马纹
    const newBottom = master.rows.length + 1 // 1 基 Excel 行号（表头第 1 行）
    if (newBottom > origRows.length + 1) {
      const relsPath = sheetPath.replace(/([^/]+)\.xml$/, '_rels/$1.xml.rels')
      const relsFile = files[relsPath]
      if (relsFile) {
        const sheetDir = sheetPath.slice(0, sheetPath.lastIndexOf('/'))
        for (const m of dec.decode(relsFile).matchAll(/<Relationship\b[^>]*\/?>/g)) {
          if (!/\/table"/.test(m[0])) continue
          const target = attrOf(m[0], 'Target')
          if (!target) continue
          const tablePath = target.startsWith('/')
            ? target.slice(1)
            : `${sheetDir}/${target}`.replace(/[^/]+\/\.\.\//g, '')
          const tf = files[tablePath]
          if (!tf) continue
          const patched = dec.decode(tf).replace(
            /(ref=")([A-Z]+\d+:[A-Z]+)(\d+)(")/g,
            (all, p1: string, cols: string, bottom: string, p4: string) =>
              Number(bottom) < newBottom ? `${p1}${cols}${newBottom}${p4}` : all,
          )
          files[tablePath] = enc.encode(patched)
        }
      }
      xml = bumpDimension(xml, newBottom)
    }
    files[sheetPath] = enc.encode(xml)
  }

  // 其他 sheet（NEGO 比价内容等）：同一套单元格补丁，只动目标格
  let extraCells = 0
  for (const extra of extras) {
    const path = findSheetPath(files, extra.sheetName)
    if (!path || !files[path]) continue
    const applied = applyRowChanges(dec.decode(files[path]), extra.changes, new Map(), '')
    formulaCellsReplaced += applied.formulaCellsReplaced
    files[path] = enc.encode(bumpDimension(applied.xml, Math.max(...extra.changes.keys())))
    for (const m of extra.changes.values()) extraCells += m.size
  }

  // 覆盖过公式单元格 → calcChain 里的引用会悬空，整体移除（Excel 会自动重建）
  if (formulaCellsReplaced > 0 && files['xl/calcChain.xml']) {
    delete files['xl/calcChain.xml']
    const ct = '[Content_Types].xml'
    if (files[ct]) {
      files[ct] = enc.encode(
        dec.decode(files[ct]).replace(/<Override[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, ''),
      )
    }
    const relPath = 'xl/_rels/workbook.xml.rels'
    if (files[relPath]) {
      files[relPath] = enc.encode(
        dec.decode(files[relPath]).replace(/<Relationship\b[^>]*Target="calcChain\.xml"[^>]*\/>/g, ''),
      )
    }
  }

  const out = zipSync(files, { level: 6 })
  return {
    buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer,
    changedCells,
    formulaCellsReplaced,
    extraCells,
  }
}
