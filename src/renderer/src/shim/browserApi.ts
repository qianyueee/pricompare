import type { PriApi, SaveXlsxRequest, SaveXlsxResult, StoreKey } from '@shared/ipc'

/** 纯浏览器环境兜底：localStorage 持久化 + Blob 触发下载（开发与 E2E 用） */
export const browserApi: PriApi = {
  isDesktop: false,
  async saveXlsx(req: SaveXlsxRequest): Promise<SaveXlsxResult> {
    const blob = new Blob([req.data], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = req.defaultFileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return { saved: true }
  },
  async showInFolder(): Promise<void> {
    // 浏览器环境无法定位文件，忽略
  },
  async storeGet(key: StoreKey): Promise<unknown> {
    const raw = localStorage.getItem(`pricompare:${key}`)
    if (raw === null) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  },
  async storeSet(key: StoreKey, value: unknown): Promise<void> {
    localStorage.setItem(`pricompare:${key}`, JSON.stringify(value))
  },
  async getVersion(): Promise<string> {
    return 'web'
  },
}
