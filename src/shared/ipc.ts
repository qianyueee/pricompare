// 主进程 / preload / 渲染进程共用的 IPC 通道名与类型。
// 渲染进程一律通过 window.api（见 src/preload）访问，纯浏览器环境用 shim 兜底。

export const IPC = {
  saveXlsx: 'dialog:save-xlsx',
  showInFolder: 'shell:show-in-folder',
  storeGet: 'store:get',
  storeSet: 'store:set',
  appVersion: 'app:version',
} as const

/** userData 里持久化的 JSON 键 */
export type StoreKey = 'settings' | 'vendorRegistry' | 'mappingTemplates' | 'lastSession'

export interface SaveXlsxRequest {
  defaultFileName: string
  /** xlsx 文件内容 */
  data: ArrayBuffer
}

export interface SaveXlsxResult {
  saved: boolean
  /** 保存成功时的完整路径（浏览器 shim 下无路径） */
  path?: string
}

export interface PriApi {
  saveXlsx(req: SaveXlsxRequest): Promise<SaveXlsxResult>
  showInFolder(path: string): Promise<void>
  storeGet(key: StoreKey): Promise<unknown>
  storeSet(key: StoreKey, value: unknown): Promise<void>
  getVersion(): Promise<string>
  /** true = Electron 环境；false = 浏览器 shim */
  isDesktop: boolean
}
