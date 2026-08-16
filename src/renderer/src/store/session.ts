import { create } from 'zustand'
import {
  SEED_VENDORS,
  analyzeSheet,
  applyMerge,
  buildMasterWorkbook,
  guessBatchLabel,
  isMasterWorkbook,
  parseMasterWorkbook,
  planMerge,
  readWorkbook,
  type AnalyzedSheet,
  type ColumnMapping,
  type MasterData,
  type ParsedWorkbook,
  type Vendor,
} from '@engine/index'
import { api } from '../api'

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
  merged?: { fill: number; append: number; batch: string }
}

export interface PendingMaster {
  fileName: string
  master: MasterData
  b64: string
  dataRows: number
}

export interface ToastMsg {
  message: string
  path?: string
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
  exportMaster(): Promise<void>
  showToast(toast: ToastMsg | null): void
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

  async init() {
    try {
      const [registry, templates, master, masterFile] = await Promise.all([
        api.storeGet('vendorRegistry'),
        api.storeGet('mappingTemplates'),
        api.storeGet('master'),
        api.storeGet('masterFile'),
      ])
      set({
        ready: true,
        registry: Array.isArray(registry) && registry.length > 0 ? (registry as Vendor[]) : SEED_VENDORS,
        templates: (templates as Record<string, MappingTemplate> | null) ?? {},
        master: (master as MasterData | null) ?? null,
        masterOriginalB64: (masterFile as { b64?: string } | null)?.b64 ?? null,
      })
    } catch {
      set({ ready: true })
    }
  },

  async addFiles(fileList: File[]) {
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
          const master = parseMasterWorkbook(pw, f.name)
          if (master) {
            set({
              pendingMaster: {
                fileName: f.name,
                master,
                b64: bufToB64(buf),
                dataRows: master.rows.filter((r) => r.cells.some((c, i) => i > 0 && c !== null)).length,
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
    const masterBefore = state.master ?? emptyMaster()
    const plan = planMerge(masterBefore, analysis.rows, {
      batch,
      vendorSlot,
      vendorId,
      vendorDisplay: display,
    })
    const master = applyMerge(masterBefore, plan)
    void api.storeSet('master', master)
    set((s) => {
      const files = s.files.map((f) =>
        f.id === fileId
          ? {
              ...f,
              analysis,
              vendorId,
              vendorDisplay: display,
              confirmed: true,
              merged: { fill: plan.fillCount, append: plan.appendCount, batch },
            }
          : f,
      )
      const next = files.find((x) => x.status === 'ok' && !x.confirmed)
      return {
        files,
        registry,
        templates,
        master,
        masterDirty: true,
        activeMappingFileId: next?.id ?? null,
        toast: {
          message: `已并入汇总：更新 ${plan.fillCount} 行，新增 ${plan.appendCount} 行（批次 ${batch}）`,
        },
      }
    })
  },

  confirmMasterImport() {
    const pending = get().pendingMaster
    if (!pending) return
    void api.storeSet('master', pending.master)
    void api.storeSet('masterFile', { name: pending.fileName, b64: pending.b64 })
    set({
      master: pending.master,
      masterOriginalB64: pending.b64,
      masterDirty: false,
      pendingMaster: null,
      toast: { message: `汇总表已更新：${pending.fileName}（${pending.dataRows} 行数据）` },
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
    else {
      const num = Number(trimmed.replace(/[,，]/g, ''))
      value = Number.isFinite(num) && /^[-+]?[\d.,，]+$/.test(trimmed) ? num : rawInput
    }
    if (row.cells[col] === value) return
    const rows = [...master.rows]
    const cells = [...row.cells]
    cells[col] = value
    rows[rowIndex] = { cells }
    const next = { ...master, rows }
    set({ master: next, masterDirty: true })
    // 编辑即持久化（防抖会在刷新/关闭时丢数据；777 行序列化只有几毫秒）
    void api.storeSet('master', next)
  },

  async exportMaster() {
    const { master, masterOriginalB64 } = get()
    if (!master) return
    set({ exporting: true })
    try {
      const buffer = await buildMasterWorkbook(master, masterOriginalB64 ? b64ToBuf(masterOriginalB64) : null)
      const saved = await api.saveXlsx({
        defaultFileName: `KK询价汇总表${todayBatch()}.xlsx`,
        data: buffer,
      })
      if (saved.saved) {
        set({ masterDirty: false, toast: { message: '汇总表已导出', path: saved.path } })
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
}))

export { guessBatchLabel }
