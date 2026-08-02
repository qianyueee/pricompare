import { create } from 'zustand'
import {
  SEED_VENDORS,
  analyzeSheet,
  readWorkbook,
  type AnalyzedSheet,
  type ColumnMapping,
  type ParsedWorkbook,
  type Vendor,
  type VendorQuotes,
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
  usdRate: number
  batchName: string
  activeMappingFileId: string | null
  importing: boolean
  toast: ToastMsg | null

  init(): Promise<void>
  addFiles(files: File[]): Promise<void>
  removeFile(id: string): void
  openMapping(id: string): void
  closeMapping(): void
  setSheet(id: string, sheetName: string): Promise<void>
  setHeaderRow(id: string, row: number): Promise<void>
  confirmMapping(input: {
    fileId: string
    mapping: ColumnMapping
    vendorDisplay: string
    saveTemplate: boolean
  }): Promise<void>
  setUsdRate(rate: number): void
  setBatchName(name: string): void
  showToast(toast: ToastMsg | null): void
}

let seq = 1

function defaultBatchName(): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `${ymd} 询价`
}

/** 供应商显示名 → 注册表 id（命中别名归并；否则以名字本身作为自定义 id） */
function resolveVendorId(registry: Vendor[], display: string): string {
  const n = display.trim().toLowerCase()
  for (const v of registry) {
    if (v.id === n || v.display.toLowerCase() === n) return v.id
    if (v.aliases.some((a) => a.toLowerCase() === n)) return v.id
  }
  return display.trim()
}

export const useSession = create<SessionState>((set, get) => ({
  ready: false,
  files: [],
  registry: SEED_VENDORS,
  templates: {},
  usdRate: 6.5,
  batchName: defaultBatchName(),
  activeMappingFileId: null,
  importing: false,
  toast: null,

  async init() {
    try {
      const [settings, registry, templates] = await Promise.all([
        api.storeGet('settings'),
        api.storeGet('vendorRegistry'),
        api.storeGet('mappingTemplates'),
      ])
      set({
        ready: true,
        usdRate:
          settings && typeof (settings as { usdRate?: unknown }).usdRate === 'number'
            ? (settings as { usdRate: number }).usdRate
            : 6.5,
        registry: Array.isArray(registry) && registry.length > 0 ? (registry as Vendor[]) : SEED_VENDORS,
        templates: (templates as Record<string, MappingTemplate> | null) ?? {},
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
        let analysis = await analyzeSheet(pw, { fileName: f.name, vendors: registry })
        const tpl = templates[analysis.fingerprint]
        let confirmed = false
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
          confirmed = true
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
          confirmed,
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

  async confirmMapping({ fileId, mapping, vendorDisplay, saveTemplate }) {
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
    set((s) => {
      const files = s.files.map((f) =>
        f.id === fileId
          ? { ...f, analysis, vendorId, vendorDisplay: display, confirmed: true, autoMapped: false }
          : f,
      )
      const next = files.find((f) => f.status === 'ok' && !f.confirmed)
      return { files, registry, templates, activeMappingFileId: next?.id ?? null }
    })
  },

  setUsdRate(rate: number) {
    set({ usdRate: rate })
    void api.storeSet('settings', { usdRate: rate })
  },

  setBatchName(name: string) {
    set({ batchName: name })
  },

  showToast(toast: ToastMsg | null) {
    set({ toast })
  },
}))

/** 已确认文件按供应商合并为比价输入 */
export function collectVendorQuotes(files: LoadedFile[]): VendorQuotes[] {
  const map = new Map<string, VendorQuotes>()
  for (const f of files) {
    if (f.status !== 'ok' || !f.confirmed || !f.analysis) continue
    const key = f.vendorId || f.vendorDisplay || f.fileName
    let vq = map.get(key)
    if (!vq) {
      vq = { vendorId: key, vendorDisplay: f.vendorDisplay || key, rows: [] }
      map.set(key, vq)
    }
    vq.rows.push(...f.analysis.rows)
  }
  return [...map.values()]
}
