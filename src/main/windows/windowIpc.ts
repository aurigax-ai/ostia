import { hostname } from 'node:os'
import { join } from 'node:path'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import {
  app,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
} from 'electron'
import type { ExternalEditorRequest } from '../../shared/app/appApi'
import type { DiscreteGpuInfo } from '../../shared/app/discreteGpu'
import { clampZoom, zoomFactor } from '../../shared/app/zoom'
import { desktopsOf } from '../../shared/keyboard/desktopChords'
import type { AppInfo } from '../../shared/types'
import { type GuestChords, registerGuestChords } from '../browser/guestChords'
import { createGuestRemap } from '../browser/guestRemap'
import { createNativeMenuKey } from '../browser/nativeMenuKeys'
import { openInExternalEditor } from '../files/externalEditor'
import type { FileServices } from '../files/filesWiring'
import { discreteGpu, gpuStartPlan, querySwitcherooGpus } from '../platform/discreteGpu'
import { appVersion } from '../updates/appVersion'
import type { AppQuit } from './appQuit'
import { type ClipboardEdits, clipboardItemData, registerClipboardEdits } from './clipboardEdits'
import { registerCloseGuard } from './closeGuard'
import { acceptsPrimarySelection } from './primarySelection'

interface WindowIpcDeps {
  requestQuit: AppQuit['requestQuit']
  broadcast: (channel: string, payload: unknown) => void
}

export function registerWindowIpc({ requestQuit, broadcast }: WindowIpcDeps) {
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
    broadcast('window:system-dark-changed', nativeTheme.shouldUseDarkColors)
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
    files: FileServices | null
  }
  windows: Map<string, BrowserWindow>
  isHumanProfile: (guest: Electron.WebContents) => boolean
}

export function registerWindowInputGuards({
  services,
  windows,
  isHumanProfile,
}: WindowInputGuardsDeps) {
  const remap = createGuestRemap({
    nativeMenuKey: createNativeMenuKey(() => Menu.getApplicationMenu()?.items ?? []),
  })
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
    write: (capture) => clipboard.write([new ClipboardItem(clipboardItemData(capture))]),
    mac: process.platform === 'darwin',
    remap,
    copyViewerSelection: (guest) => services.files?.viewers.copyForGuest(guest) ?? false,
  })
  services.guestChords = registerGuestChords({
    ipc: ipcMain,
    isAppWindow: (sender) => windows.get(String(sender.id))?.webContents === sender,
    mac: process.platform === 'darwin',
    remap,
    isHumanBrowser: isHumanProfile,
    viewerOwnsFindKeys: (guest) => services.files?.viewers.ownsFindKeys(guest) ?? false,
  })
}
