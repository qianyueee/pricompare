import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type PriApi, type SaveXlsxRequest, type StoreKey } from '../shared/ipc'

const api: PriApi = {
  saveXlsx: (req: SaveXlsxRequest) => ipcRenderer.invoke(IPC.saveXlsx, req),
  showInFolder: (path: string) => ipcRenderer.invoke(IPC.showInFolder, path),
  storeGet: (key: StoreKey) => ipcRenderer.invoke(IPC.storeGet, key),
  storeSet: (key: StoreKey, value: unknown) => ipcRenderer.invoke(IPC.storeSet, key, value),
  getVersion: () => ipcRenderer.invoke(IPC.appVersion),
  isDesktop: true,
}

contextBridge.exposeInMainWorld('api', api)
