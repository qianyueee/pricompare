import type { PriApi } from '@shared/ipc'
import { browserApi } from './shim/browserApi'

/** Electron preload 注入的 window.api 优先；纯浏览器（开发/E2E）走 shim */
export const api: PriApi = window.api ?? browserApi
