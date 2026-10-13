import type { PriApi } from '@shared/ipc'
import { browserApi } from './shim/browserApi'
import { serverApi, servedByPricompareServer } from './shim/serverApi'

/**
 * Electron preload 注入的 window.api 优先；
 * 由 Mac 上的 pricompare 服务发出的网页走服务端接口；其余纯浏览器（开发/E2E）走 localStorage shim。
 */
export const api: PriApi = window.api ?? (servedByPricompareServer() ? serverApi : browserApi)
