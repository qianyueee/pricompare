import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { IPC, type SaveXlsxRequest, type SaveXlsxResult } from '../shared/ipc'
import { storeGet, storeSet } from './store'

export function registerIpc(): void {
  ipcMain.handle(IPC.saveXlsx, async (event, req: SaveXlsxRequest): Promise<SaveXlsxResult> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: '导出 KK 汇总',
      defaultPath: req.defaultFileName,
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsm', 'xlsx'] }],
    })
    if (canceled || !filePath) return { saved: false }
    writeFileSync(filePath, Buffer.from(req.data))
    return { saved: true, path: filePath }
  })

  ipcMain.handle(IPC.showInFolder, (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle(IPC.storeGet, (_event, key: string) => storeGet(key))

  ipcMain.handle(IPC.storeSet, (_event, key: string, value: unknown) => {
    storeSet(key, value)
  })

  ipcMain.handle(IPC.appVersion, () => app.getVersion())
}
