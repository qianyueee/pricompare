import { create } from 'zustand'
import {
  AMOUNT_COLS,
  KK_COL_COUNT,
  SEED_VENDORS,
  analyzeSheet,
  applyMasterOp,
  buildMasterWorkbook,
  cleanAmountString,
  cleanMasterAmounts,
  guessBatchLabel,
  isMasterWorkbook,
  migrateMasterLayout,
  migrateVendorRegistry,
  parseMasterWorkbook,
  readWorkbook,
  type AnalyzedSheet,
  type CellChange,
  type ColumnMapping,
  type MasterData,
  type MasterOp,
  type OpResult,
  type ParsedWorkbook,
  type Vendor,
  dedupeNegoLinesByPn,
} from '@engine/index'
import type { ServerRole } from '@shared/serverApi'
import { api } from '../api'
import { createMasterSync, type MasterSync } from './masterSync'

export interface MappingTemplate {
  sheetName: string
  mapping: ColumnMapping
  vendorId: string
  vendorDisplay: string
  label: string
  savedAt: number
}

export interface LoadedFile {
  id: string
  fileName: string
  status: 'ok' | 'error'
  error?: string
  pw?: ParsedWorkbook
  sheetNames: string[]
  analysis?: AnalyzedSheet
  vendorId: string
  vendorDisplay: string
  confirmed: boolean
  autoMapped: boolean
  /** 已并入汇总的结果摘要 */
  merged?: { fill: number; append: number; revise?: number; skip?: number; batch: string }
}

export interface PendingMaster {
  fileName: string
  master: MasterData
  b64: string
  dataRows: number
  /** 导入时自动修正的文本金额单元格数 */
  cleanedCount: number
}

export interface ToastMsg {
  message: string
  path?: string
}

/* ---- NEGO 比价页行辅助（自由输入 pn/qty，末尾恒保一空行供继续输入） ---- */
let negoSeq = 1
const emptyNegoLine = () => ({ id: negoSeq++, pn: '', qty: null as number | null })
const isEmptyNegoLine = (l: { pn: string; qty: number | null }) => l.pn.trim() === '' && l.qty === null
function withTrailingEmptyNego<T extends { pn: string; qty: number | null }>(lines: T[]): T[] {
  const last = lines[lines.length - 1]
  if (last && isEmptyNegoLine(last)) return lines
  return [...lines, emptyNegoLine() as unknown as T]
}
const negoKey = (pn: string) => pn.trim().toUpperCase()
/** 单元格/粘贴文本 → 数量：数字直取，文本走金额清洗（'12'、'￥12' → 12），其余 null */
function negoQtyFrom(v: string | number | null): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v === null) return null
  return cleanAmountString(String(v))
}

interface SessionState {
  ready: boolean
  files: LoadedFile[]
  registry: Vendor[]
  templates: Record<string, MappingTemplate>
  master: MasterData | null
  masterOriginalB64: string | null
  /** 有尚未导出的更改 */
  masterDirty: boolean
  pendingMaster: PendingMaster | null
  activeMappingFileId: string | null
  importing: boolean
  exporting: boolean
  toast: ToastMsg | null
  /** 最近一次手工编辑（单格改/删行/清空）的反向操作——单槽撤销 */
  undo: { op: MasterOp; label: string } | null
  /** editor 可改总表；viewer（网页版只读账号）只能看、比价、导出 */
  role: ServerRole
  /** 网页版连着 Mac 上的服务时的登录身份；桌面版为 null */
  user: string | null
  /** 本页总表对应的服务端版本（仅网页版连服务时有意义） */
  masterVersion: number
  negoOpen: boolean
  /** NEGO 比价页行：自由输入的编号 + 下单数量（档位在渲染时按总表解析） */
  negoLines: { id: number; pn: string; qty: number | null }[]

  init(): Promise<void>
  addFiles(files: File[]): Promise<void>
  removeFile(id: string): void
  openMapping(id: string): void
  closeMapping(): void
  setSheet(id: string, sheetName: string): Promise<void>
  setHeaderRow(id: string, row: number): Promise<void>
  confirmMerge(input: {
    fileId: string
    mapping: ColumnMapping
    vendorDisplay: string
    saveTemplate: boolean
    batch: string
    vendorSlot: number
  }): Promise<void>
  confirmMasterImport(): void
  cancelMasterImport(): void
  editMasterCell(rowIndex: number, col: number, rawInput: string): void
  /** 删除整行（A 列重排）；可 Ctrl+Z 撤销一步 */
  deleteRows(rowIdxs: number[]): void
  /** 清空所选格内容（Excel Delete 语义，A 列不清）；可 Ctrl+Z 撤销一步 */
  clearCells(targets: { rowIndex: number; cols: number[] }[]): void
  undoMasterEdit(): void
  exportMaster(): Promise<void>
  showToast(toast: ToastMsg | null): void
  openNego(rowIdxs: number[]): void
  closeNego(): void
  clearNego(): void
  setNegoPn(index: number, pn: string): void
  /** 零件号输入提交：按零件号合并（先出现的行为准）；返回该零件号最终所在行与是否发生了合并 */
  commitNegoPn(index: number): { index: number; merged: boolean }
  setNegoQty(index: number, qty: number | null): void
  removeNegoLine(index: number): void
  /** 类 Excel 粘贴：从 startIndex 行、col 列起铺开剪贴板网格（pn 列可带第二列数量） */
  pasteNego(startIndex: number, col: 'pn' | 'qty', grid: string[][]): void
}

let seq = 1

export function todayBatch(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

/** 供应商显示名 → 注册表 id（命中别名归并；否则以名字本身作为自定义 id） */
export function resolveVendorId(registry: Vendor[], display: string): string {
  const n = display.trim().toLowerCase()
  for (const v of registry) {
    if (v.id === n || v.display.toLowerCase() === n) return v.id
    if (v.aliases.some((a) => a.toLowerCase() === n)) return v.id
  }
  return display.trim()
}

function emptyMaster(): MasterData {
  return {
    rows: [],
    sheetName: 'KK询价汇总',
    passthrough: [],
    sourceFileName: null,
    importedAt: Date.now(),
  }
}

const READ_ONLY_MSG = '只读账号不能修改总表'

/** 网页版连着 Mac 上的服务时才有：负责把本页的改动发给服务、把别处的改动取回来 */
let sync: MasterSync | null = null

/**
 * 总表的所有改动都走这里：先在本页立即生效，再保存——
 * 桌面版和本地浏览器整表存盘；网页版把这一步操作发给 Mac 上的服务，由服务按顺序应用。
 * 只读账号返回 null；没有改动时返回结果但不保存。
 */
function commitMasterOp(op: MasterOp, patch: (r: OpResult) => Partial<SessionState>): OpResult | null {
  const s = useSession.getState()
  if (s.role !== 'editor') {
    useSession.setState({ toast: { message: READ_ONLY_MSG } })
    return null
  }
  const res = applyMasterOp(s.master ?? emptyMaster(), op)
  if (res.master === s.master) return res
  useSession.setState({ master: res.master, masterDirty: true, ...patch(res) })
  if (sync) sync.push(op)
  else void api.storeSet('master', res.master) // 编辑即持久化（防抖会在刷新/关闭时丢数据；序列化只要几毫秒）
  return res
}

async function initFromServer(): Promise<void> {
  const server = api.server!
  const [session, snap, registry, templates] = await Promise.all([
    server.session(),
    server.getMaster(),
    api.storeGet('vendorRegistry'),
    api.storeGet('mappingTemplates'),
  ])
  const savedRegistry = Array.isArray(registry) && registry.length > 0 ? (registry as Vendor[]) : null
  useSession.setState({
    ready: true,
    role: session.role,
    user: session.user,
    registry: savedRegistry ? migrateVendorRegistry(savedRegistry).registry : SEED_VENDORS,
    templates: (templates as Record<string, MappingTemplate> | null) ?? {},
    master: snap.master,
    masterVersion: snap.version,
  })
  if (sync) return
  sync = createMasterSync(server, {
    getMaster: () => useSession.getState().master,
    getVersion: () => useSession.getState().masterVersion,
    setVersion: (version) => useSession.setState({ masterVersion: version }),
    // 别处删行/插行后，本页的撤销步骤行号已对不上，作废
    applyRemote: (master, version, shifted) =>
      useSession.setState(shifted ? { master, masterVersion: version, undo: null } : { master, masterVersion: version }),
    replaceFromServer: (master, version) => useSession.setState({ master, masterVersion: version, undo: null }),
    notify: (message) => useSession.setState({ toast: { message } }),
  })
  sync.start()
}

export const useSession = create<SessionState>((set, get) => ({
  ready: false,
  files: [],
  registry: SEED_VENDORS,
  templates: {},
  master: null,
  masterOriginalB64: null,
  masterDirty: false,
  pendingMaster: null,
  activeMappingFileId: null,
  importing: false,
  exporting: false,
  toast: null,
  undo: null,
  // 网页版在拿到登录身份前先按只读显示，免得只读账号看到一闪而过的导入按钮
  role: api.server ? 'viewer' : 'editor',
  user: null,
  masterVersion: 0,
  negoOpen: false,
  negoLines: [emptyNegoLine()],

  async init() {
    if (api.server) {
      try {
        await initFromServer()
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        set({ ready: true, toast: { message: `连不上 pricompare 服务：${reason}` } })
      }
      return
    }
    try {
      const [registry, templates, master, masterFile] = await Promise.all([
        api.storeGet('vendorRegistry'),
        api.storeGet('mappingTemplates'),
        api.storeGet('master'),
        api.storeGet('masterFile'),
      ])
      let loadedMaster = (master as MasterData | null) ?? null
      let cleanedOnInit = 0
      let migratedRows = 0
      if (loadedMaster) {
        // 10-07 之前存下的 33 列总表 → 34 列新布局（CL 列、YJ 挪到 AG）
        const migrated = migrateMasterLayout(loadedMaster)
        loadedMaster = migrated.master
        migratedRows = migrated.migratedRows
        const cleaned = cleanMasterAmounts(loadedMaster)
        loadedMaster = cleaned.master
        cleanedOnInit = cleaned.changed
        if (cleanedOnInit > 0 || migratedRows > 0) void api.storeSet('master', loadedMaster)
      }
      let loadedRegistry = Array.isArray(registry) && registry.length > 0 ? (registry as Vendor[]) : SEED_VENDORS
      const regMigration = migrateVendorRegistry(loadedRegistry)
      if (regMigration.migrated) {
        loadedRegistry = regMigration.registry
        void api.storeSet('vendorRegistry', loadedRegistry)
      }
      const notes: string[] = []
      if (migratedRows > 0) notes.push(`总表已换成 10-07 新布局（新增 L 列 CL，YJ 挪到 AG），共 ${migratedRows} 行`)
      if (cleanedOnInit > 0) notes.push(`已自动规范 ${cleanedOnInit} 个文本格式金额（如 ￥1,133.40 → 1133.4）`)
      set({
        ready: true,
        registry: loadedRegistry,
        templates: (templates as Record<string, MappingTemplate> | null) ?? {},
        master: loadedMaster,
        masterOriginalB64: (masterFile as { b64?: string } | null)?.b64 ?? null,
        ...(notes.length > 0 ? { masterDirty: true, toast: { message: notes.join('；') } } : {}),
      })
    } catch {
      set({ ready: true })
    }
  },

  async addFiles(fileList: File[]) {
    if (get().role !== 'editor') {
      set({ toast: { message: READ_ONLY_MSG } })
      return
    }
    set({ importing: true })
    const { registry, templates } = get()
    const added: LoadedFile[] = []
    for (const f of fileList) {
      const id = `f${seq++}`
      try {
        const buf = await f.arrayBuffer()
        const pw = readWorkbook(buf)
        // 汇总表拖入 → 走"更新汇总"确认流程，而不是报价映射
        if (isMasterWorkbook(pw)) {
          const parsed = parseMasterWorkbook(pw, f.name)
          if (parsed) {
            const { master, changed } = cleanMasterAmounts(parsed)
            set({
              pendingMaster: {
                fileName: f.name,
                master,
                b64: bufToB64(buf),
                dataRows: master.rows.filter((r) => r.cells.some((c, i) => i > 0 && c !== null)).length,
                cleanedCount: changed,
              },
              importing: false,
            })
            continue
          }
        }
        let analysis = await analyzeSheet(pw, { fileName: f.name, vendors: registry })
        const tpl = templates[analysis.fingerprint]
        let autoMapped = false
        let vendorId = ''
        let vendorDisplay = ''
        if (tpl) {
          analysis = await analyzeSheet(pw, {
            fileName: f.name,
            vendors: registry,
            sheetName: tpl.sheetName,
            mappingOverride: tpl.mapping,
          })
          autoMapped = true
          vendorId = tpl.vendorId
          vendorDisplay = tpl.vendorDisplay
        } else if (analysis.vendorGuess.vendorId) {
          vendorId = analysis.vendorGuess.vendorId
          vendorDisplay = registry.find((v) => v.id === vendorId)?.display ?? vendorId
        }
        added.push({
          id,
          fileName: f.name,
          status: 'ok',
          pw,
          sheetNames: pw.sheetNames,
          analysis,
          vendorId,
          vendorDisplay,
          confirmed: false,
          autoMapped,
        })
      } catch (err) {
        added.push({
          id,
          fileName: f.name,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          sheetNames: [],
          vendorId: '',
          vendorDisplay: '',
          confirmed: false,
          autoMapped: false,
        })
      }
    }
    set((s) => {
      const files = [...s.files, ...added]
      const next = files.find((f) => f.status === 'ok' && !f.confirmed)
      return { files, importing: false, activeMappingFileId: s.activeMappingFileId ?? next?.id ?? null }
    })
  },

  removeFile(id: string) {
    set((s) => ({
      files: s.files.filter((f) => f.id !== id),
      activeMappingFileId: s.activeMappingFileId === id ? null : s.activeMappingFileId,
    }))
  },

  openMapping(id: string) {
    const file = get().files.find((f) => f.id === id)
    if (file?.merged) return // 已并入的文件不允许重复合并
    set({ activeMappingFileId: id })
  },

  closeMapping() {
    set({ activeMappingFileId: null })
  },

  async setSheet(id: string, sheetName: string) {
    const file = get().files.find((f) => f.id === id)
    if (!file?.pw) return
    const analysis = await analyzeSheet(file.pw, {
      fileName: file.fileName,
      vendors: get().registry,
      sheetName,
    })
    set((s) => ({
      files: s.files.map((f) => (f.id === id ? { ...f, analysis, confirmed: false, autoMapped: false } : f)),
    }))
  },

  async setHeaderRow(id: string, row: number) {
    const file = get().files.find((f) => f.id === id)
    if (!file?.pw || !file.analysis) return
    const analysis = await analyzeSheet(file.pw, {
      fileName: file.fileName,
      vendors: get().registry,
      sheetName: file.analysis.sheetName,
      forcedHeaderRow: row,
    })
    set((s) => ({
      files: s.files.map((f) => (f.id === id ? { ...f, analysis, confirmed: false } : f)),
    }))
  },

  async confirmMerge({ fileId, mapping, vendorDisplay, saveTemplate, batch, vendorSlot }) {
    const state = get()
    const file = state.files.find((f) => f.id === fileId)
    if (!file?.pw || !file.analysis) return
    if (state.role !== 'editor') {
      set({ toast: { message: READ_ONLY_MSG } })
      return
    }
    const analysis = await analyzeSheet(file.pw, {
      fileName: file.fileName,
      vendors: state.registry,
      sheetName: file.analysis.sheetName,
      mappingOverride: mapping,
    })
    const display = vendorDisplay.trim()
    const vendorId = resolveVendorId(state.registry, display)
    let registry = state.registry
    if (!registry.some((v) => v.id === vendorId)) {
      registry = [...registry, { id: vendorId, display, aliases: [display.toLowerCase()] }]
      void api.storeSet('vendorRegistry', registry)
    }
    let templates = state.templates
    if (saveTemplate) {
      templates = {
        ...templates,
        [analysis.fingerprint]: {
          sheetName: analysis.sheetName,
          mapping,
          vendorId,
          vendorDisplay: display,
          label: `${display} · ${file.fileName}`,
          savedAt: Date.now(),
        },
      }
      void api.storeSet('mappingTemplates', templates)
    }
    // 并入也是一步总表操作：网页版由服务在最新总表上按同样规则重新规划，不会盖掉后台刚并入的报价
    const res = commitMasterOp(
      { kind: 'merge', quotes: analysis.rows, options: { batch, vendorSlot, vendorId, vendorDisplay: display } },
      () => ({ undo: null }), // 并入后旧撤销作废（撤销只针对手工编辑/删行/清空）
    )
    const m = res?.merge
    if (!m) return
    set((s) => {
      const files = s.files.map((f) =>
        f.id === fileId
          ? {
              ...f,
              analysis,
              vendorId,
              vendorDisplay: display,
              confirmed: true,
              merged: { fill: m.fill, append: m.append, revise: m.revise, skip: m.skip, batch },
            }
          : f,
      )
      const next = files.find((x) => x.status === 'ok' && !x.confirmed)
      return {
        files,
        registry,
        templates,
        activeMappingFileId: next?.id ?? null,
        toast: {
          message: `已并入汇总：更新 ${m.fill} 行，新增 ${m.append} 行${m.revise > 0 ? `，修订 ${m.revise} 行` : ''}${m.skip > 0 ? `，跳过 ${m.skip} 行（已在表内）` : ''}（批次 ${batch}）`,
        },
      }
    })
  },

  confirmMasterImport() {
    const pending = get().pendingMaster
    if (!pending) return
    if (get().role !== 'editor') {
      set({ pendingMaster: null, toast: { message: READ_ONLY_MSG } })
      return
    }
    const file = { name: pending.fileName, b64: pending.b64 }
    if (sync) {
      void sync.importMaster({ master: pending.master, file })
    } else {
      void api.storeSet('master', pending.master)
      void api.storeSet('masterFile', file)
    }
    set({
      master: pending.master,
      // 网页版的原件存在服务上，导出时再取
      masterOriginalB64: sync ? null : pending.b64,
      masterDirty: false,
      pendingMaster: null,
      undo: null,
      toast: {
        message:
          `汇总表已更新：${pending.fileName}（${pending.dataRows} 行数据）` +
          (pending.cleanedCount > 0 ? `，已规范 ${pending.cleanedCount} 个文本金额` : ''),
      },
    })
  },

  cancelMasterImport() {
    set({ pendingMaster: null })
  },

  editMasterCell(rowIndex: number, col: number, rawInput: string) {
    const master = get().master
    if (!master || col === 0) return
    const row = master.rows[rowIndex]
    if (!row) return
    const trimmed = rawInput.trim()
    let value: string | number | null
    if (trimmed === '') value = null
    else if (AMOUNT_COLS.includes(col)) {
      value = cleanAmountString(trimmed) ?? rawInput
    } else {
      const num = Number(trimmed.replace(/[,，]/g, ''))
      value = Number.isFinite(num) && /^[-+]?[\d.,，]+$/.test(trimmed) ? num : rawInput
    }
    if (row.cells[col] === value) return
    commitMasterOp({ kind: 'setCells', cells: [{ row: rowIndex, col, value }] }, (r) => ({
      undo: r.inverse ? { op: r.inverse, label: '单元格编辑' } : null,
    }))
  },

  deleteRows(rowIdxs: number[]) {
    const master = get().master
    if (!master || rowIdxs.length === 0) return
    commitMasterOp({ kind: 'deleteRows', rows: rowIdxs }, (r) => ({
      undo: r.inverse ? { op: r.inverse, label: `删除 ${rowIdxs.length} 行` } : null,
      toast: { message: `已删除 ${rowIdxs.length} 行（A 列序号已重排，Ctrl+Z 可撤销）` },
    }))
  },

  clearCells(targets: { rowIndex: number; cols: number[] }[]) {
    const master = get().master
    if (!master) return
    // Excel Delete 语义：A 列序号不清，越界行/列忽略
    const cells: CellChange[] = []
    for (const t of targets) {
      if (!master.rows[t.rowIndex]) continue
      for (const c of t.cols) if (c > 0 && c < KK_COL_COUNT) cells.push({ row: t.rowIndex, col: c, value: null })
    }
    if (cells.length === 0) return
    const count = targets.reduce((s, t) => s + t.cols.filter((c) => c > 0).length, 0)
    commitMasterOp({ kind: 'setCells', cells }, (r) => ({
      undo: r.inverse ? { op: r.inverse, label: '清空内容' } : null,
      toast: { message: `已清空 ${count} 个单元格（Ctrl+Z 可撤销）` },
    }))
  },

  undoMasterEdit() {
    const undo = get().undo
    if (!undo) return
    commitMasterOp(undo.op, () => ({ undo: null, toast: { message: `已撤销：${undo.label}` } }))
    if (get().undo === undo) set({ undo: null }) // 没有可撤销的改动（别处已改回）时也清掉这一步
  },

  async exportMaster() {
    const { master, masterOriginalB64 } = get()
    if (!master) return
    set({ exporting: true })
    try {
      // 网页版的原始 KK 汇总表存在服务上，导出时才取（在它上面打补丁，格式和以前发给 Tony 的一样）
      const originalB64 = api.server ? ((await api.server.getMasterFile())?.b64 ?? null) : masterOriginalB64
      const out = await buildMasterWorkbook(master, originalB64 ? b64ToBuf(originalB64) : null)
      const saved = await api.saveXlsx({
        // 扩展名必须跟随内容类型（.xlsm 原表导出仍为 .xlsm），否则 Excel 拒绝打开
        defaultFileName: `KK询价汇总表${todayBatch()}.${out.extension}`,
        data: out.buffer,
      })
      if (saved.saved) {
        set({
          masterDirty: false,
          toast: {
            message:
              out.mode === 'rewrite'
                ? '汇总表已导出（注意：保真补丁失败，本次为降级导出，公式/样式可能有损，请反馈）'
                : '汇总表已导出',
            path: saved.path,
          },
        })
      }
    } catch (err) {
      set({ toast: { message: `导出失败：${err instanceof Error ? err.message : String(err)}` } })
    } finally {
      set({ exporting: false })
    }
  },

  showToast(toast: ToastMsg | null) {
    set({ toast })
  },

  openNego(rowIdxs: number[]) {
    set((s) => {
      const master = s.master
      const kept = s.negoLines.filter((l) => !isEmptyNegoLine(l))
      // 同零件号只保留一行（先出现的为准，含已在页内的）：选了同一件的多个数量档也只带入一行
      const seen = new Set(kept.map((l) => negoKey(l.pn)))
      if (master) {
        for (const i of [...new Set(rowIdxs)].sort((a, b) => a - b)) {
          const cells = master.rows[i]?.cells
          if (!cells) continue
          const pn = String(cells[3] ?? '').trim()
          if (!pn) continue
          const key = negoKey(pn)
          if (seen.has(key)) continue
          seen.add(key)
          kept.push({ id: negoSeq++, pn, qty: negoQtyFrom(cells[6] ?? null) })
        }
      }
      return { negoOpen: true, negoLines: withTrailingEmptyNego(kept) }
    })
  },

  closeNego() {
    set({ negoOpen: false }) // 保留已填内容，下次进入接着用
  },

  clearNego() {
    set({ negoLines: [emptyNegoLine()] })
  },

  setNegoPn(index: number, pn: string) {
    set((s) => ({
      negoLines: withTrailingEmptyNego(s.negoLines.map((l, i) => (i === index ? { ...l, pn } : l))),
    }))
  },

  commitNegoPn(index: number) {
    const s = get()
    const target = s.negoLines[index]
    if (!target || target.pn.trim() === '') return { index, merged: false }
    const deduped = dedupeNegoLinesByPn(s.negoLines)
    const key = negoKey(target.pn)
    const kept = deduped.findIndex((l) => negoKey(l.pn) === key)
    const merged = deduped.length !== s.negoLines.length
    if (merged) set({ negoLines: withTrailingEmptyNego(deduped) })
    return { index: kept < 0 ? index : kept, merged }
  },

  setNegoQty(index: number, qty: number | null) {
    set((s) => ({
      negoLines: withTrailingEmptyNego(s.negoLines.map((l, i) => (i === index ? { ...l, qty } : l))),
    }))
  },

  removeNegoLine(index: number) {
    set((s) => ({ negoLines: withTrailingEmptyNego(s.negoLines.filter((_, i) => i !== index)) }))
  },

  pasteNego(startIndex: number, col: 'pn' | 'qty', grid: string[][]) {
    set((s) => {
      const lines = [...s.negoLines]
      for (let i = 0; i < grid.length; i++) {
        const idx = startIndex + i
        while (lines.length <= idx) lines.push(emptyNegoLine())
        const cells = grid[i]!
        const line = { ...lines[idx]! }
        if (col === 'pn') {
          if (cells[0] !== undefined) line.pn = cells[0].trim()
          if (cells.length > 1) line.qty = negoQtyFrom(cells[1]!.trim())
        } else if (cells[0] !== undefined) {
          line.qty = negoQtyFrom(cells[0].trim())
        }
        lines[idx] = line
      }
      // 粘贴的一列里有重复零件号 → 只保留先出现的一行
      return { negoLines: withTrailingEmptyNego(dedupeNegoLinesByPn(lines)) }
    })
  },
}))

export { guessBatchLabel }
