import { BrowserWindow, Menu, app, dialog, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { storeGet, storeSet } from './store'

const rendererUrl = process.env['ELECTRON_RENDERER_URL']

function resolvePreload(): string {
  const dir = join(import.meta.dirname, '../preload')
  for (const name of ['index.mjs', 'index.js', 'index.cjs']) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return join(dir, 'index.js')
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [{ label: '退出', role: 'quit' }],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: '询价比价系统',
              detail: `版本 ${app.getVersion()}\n供应商报价 Excel 统一解析、比价与 KK 格式导出。\n所有数据仅保存在本机。`,
            })
          },
        },
      ],
    },
  ])
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    title: '询价比价系统',
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

// 无界面冒烟测试：--smoke 时只验证持久化读写后退出（供无显示环境 CI 用）
function runSmoke(): void {
  const probe = { at: Date.now(), ok: true }
  storeSet('settings', probe)
  const back = storeGet('settings') as typeof probe | null
  if (back && back.ok === true && back.at === probe.at) {
    console.log('SMOKE_OK')
    app.exit(0)
  } else {
    console.error('SMOKE_FAIL', back)
    app.exit(1)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app.whenReady().then(() => {
    if (process.argv.includes('--smoke')) {
      runSmoke()
      return
    }
    Menu.setApplicationMenu(buildMenu())
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
