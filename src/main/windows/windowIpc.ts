import { hostname } from 'node:os'
import { join } from 'node:path'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { BrowserWindow, app, clipboard, ipcMain, nativeTheme, shell } from 'electron'
import type { ExternalEditorRequest } from '../../shared/app/appApi'
import type { DiscreteGpuInfo } from '../../shared/app/discreteGpu'
import { clampZoom, zoomFactor } from '../../shared/app/zoom'
import { desktopsOf } from '../../shared/keyboard/desktopChords'
import type { AppInfo } from '../../shared/types'
import { type GuestChords, registerGuestChords } from '../browser/guestChords'
import { openInExternalEditor } from '../files/externalEditor'
import { discreteGpu, gpuStartPlan, querySwitcherooGpus } from '../platform/discreteGpu'
import { appVersion } from '../updates/appVersion'
import type { AppQuit } from './appQuit'
import { type ClipboardEdits, registerClipboardEdits } from './clipboardEdits'
import { registerCloseGuard } from './closeGuard'
import { acceptsPrimarySelection } from './primarySelection'

interface WindowIpcDeps {
  requestQuit: AppQuit['requestQuit']
}

export function registerWindowIpc({ requestQuit }: WindowIpcDeps) {
  ipcMain.handle('app:ping', () => 'pong' as const)
  ipcMain.handle('settings:path', () => join(app.getPath('userData'), 'settings.json'))
  ipcMain.handle('editor:open-external', (_e, req: ExternalEditorRequest) =>
    openInExternalEditor(req),
  )
  ipcMain.handle(
    'app:info',
    (): AppInfo => ({
      name: PRODUCT_DISPLAY_NAME,
      version: appVersion(),
      platform: process.platform,
      hostName: hostname(),
      home: app.getPath('home'),
      desktops: process.platform === 'linux' ? desktopsOf(process.env.XDG_CURRENT_DESKTOP) : [],
    }),
  )

  registerCloseGuard()
  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('window:toggle-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('window:quit', () => requestQuit())
  ipcMain.handle('window:system-dark', () => nativeTheme.shouldUseDarkColors)
  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('window:system-dark-changed', nativeTheme.shouldUseDarkColors)
      }
    }
  })
  ipcMain.on('window:beep', () => shell.beep())
  ipcMain.on('window:write-primary', (_e, text: unknown) => {
    if (acceptsPrimarySelection(process.platform, text)) {
      clipboard.selection?.writeText(text).catch(() => undefined)
    }
  })
  ipcMain.handle('window:set-zoom', (e, percent: unknown) => {
    const clamped = clampZoom(percent)
    e.sender.setZoomFactor(zoomFactor(clamped))
    return clamped
  })
  ipcMain.handle(
    'window:is-maximized',
    (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false,
  )
  ipcMain.handle('system:discrete-gpu', async (): Promise<DiscreteGpuInfo | null> => {
    if (process.platform !== 'linux') return null
    const gpu = discreteGpu(await querySwitcherooGpus())
    return gpu ? { name: gpu.name, inUse: gpuStartPlan(process.env, gpu).kind === 'stay' } : null
  })
}

interface WindowInputGuardsDeps {
  services: {
    clipboardEdits: ClipboardEdits | null
    guestChords: GuestChords | null
  }
  windows: Map<string, BrowserWindow>
}

export function registerWindowInputGuards({ services, windows }: WindowInputGuardsDeps) {
  services.clipboardEdits = registerClipboardEdits({
    ipc: ipcMain,
    isAppWindow: (sender) => windows.get(String(sender.id))?.webContents === sender,
    snapshot: async () => {
      const items = await clipboard.read()
      const listed = items.find((item) => item.types.includes('text/uri-list'))
      return {
        formats: items.flatMap((item) => item.types),
        uriList: listed ? await (await listed.getType('text/uri-list')).text() : '',
      }
    },
    mac: process.platform === 'darwin',
  })
  services.guestChords = registerGuestChords({
    ipc: ipcMain,
    isAppWindow: (sender) => windows.get(String(sender.id))?.webContents === sender,
    mac: process.platform === 'darwin',
  })
}
