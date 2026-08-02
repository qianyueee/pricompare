import type { PriApi } from '../shared/ipc'

declare global {
  interface Window {
    /** Electron preload 注入；纯浏览器环境为 undefined，由 shim 兜底 */
    api?: PriApi
  }
}

export {}
