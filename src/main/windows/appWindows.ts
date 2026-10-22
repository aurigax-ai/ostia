import { join } from 'node:path'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { app, BrowserWindow, nativeTheme } from 'electron'
import appIcon from '../../../resources/icon.png?asset'
import { SOFTWARE_WEBGL_ARG } from '../../shared/app/discreteGpu'
import { NO_NEW_PRIVS_ARG } from '../../shared/app/noNewPrivs'
import type { WindowBounds } from '../../shared/workspaces/workspaceApi'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { GitService } from '../git/service'
import { readNoNewPrivs } from '../platform/noNewPrivs'
import type { SettingsFile } from '../platform/settingsFile'
import type { PortsService } from '../ports/service'
import { type GlobalHotkey, toggleWindows } from './globalHotkey'
import type { AppTray } from './tray'
import { MAIN_SLOT } from './windowBook'
import type { WindowBroker } from './windowBroker'
import type { WindowWiring } from './windowWiring'

interface AppWindowsDeps {
  wireWindow: WindowWiring['wireWindow']
  services: {
    appTray: AppTray | null
    broker: WindowBroker | null
    extensionHost: ExtensionHost | null
    gitService: GitService | null
    globalHotkey: GlobalHotkey | null
    portsService: PortsService | null
  }
  readSettingsFile: () => SettingsFile
  windows: Map<string, BrowserWindow>
}

export type AppWindows = ReturnType<typeof createAppWindows>

export function createAppWindows({
  wireWindow,
  services,
  readSettingsFile,
  windows,
}: AppWindowsDeps) {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL

  function frameOptions(): Electron.BrowserWindowConstructorOptions {
    if (process.platform === 'darwin') {
      return { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 11 } }
    }
    return { frame: false }
  }

  function baseWebPreferences(): Electron.WebPreferences {
    return {
      preload: join(app.getAppPath(), 'out/preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
      additionalArguments: [
        ...(app.commandLine.hasSwitch('enable-unsafe-swiftshader') ? [SOFTWARE_WEBGL_ARG] : []),
        ...(readNoNewPrivs() ? [NO_NEW_PRIVS_ARG] : []),
      ],
    }
  }

  function initialBackground(): string {
    const follow = (readSettingsFile() as { appearance?: { followSystem?: unknown } }).appearance
      ?.followSystem
    return follow !== false && !nativeTheme.shouldUseDarkColors ? '#fbfcfd' : '#1d2022'
  }

  function createWindow(slot: string, bounds?: WindowBounds): BrowserWindow {
    const win = new BrowserWindow({
      ...(bounds ?? { width: 1280, height: 800 }),
      minWidth: 720,
      minHeight: 480,
      backgroundColor: initialBackground(),
      show: false,
      autoHideMenuBar: true,
      title: PRODUCT_DISPLAY_NAME,
      icon: appIcon,
      ...frameOptions(),
      webPreferences: baseWebPreferences(),
    })

    wireWindow(win)
    services.broker?.track(win, slot)

    if (devServerUrl) {
      win.loadURL(devServerUrl)
      if (slot === MAIN_SLOT) win.webContents.openDevTools({ mode: 'detach' })
    } else {
      win.loadFile(join(app.getAppPath(), 'out/renderer/index.html'))
    }

    return win
  }

  function revealWindow(windowId: string): void {
    const win = windows.get(windowId)
    if (win && !win.isDestroyed() && !win.isVisible()) services.appTray?.showWindows()
  }

  function emitFocusChanged(): void {
    const focused = BrowserWindow.getFocusedWindow() !== null
    services.extensionHost?.events.emitEvent('focus.changed', { focused })
    services.gitService?.setFocused(focused)
    services.portsService?.setFocused(focused)
  }

  function toggleAllWindows(): void {
    toggleWindows([...windows.values()], services.appTray, revealApp)
  }

  function applyGlobalHotkey(): void {
    const status = services.globalHotkey?.apply(readSettingsFile().workspaces?.globalHotkey)
    if (status === 'taken') console.warn('[global hotkey] the chosen shortcut is in use elsewhere')
  }

  function revealApp(): void {
    if (windows.size === 0) {
      createWindow(MAIN_SLOT, services.broker?.restoredBounds(MAIN_SLOT))
    } else services.appTray?.showWindows()
  }

  return {
    createWindow,
    revealWindow,
    emitFocusChanged,
    toggleAllWindows,
    applyGlobalHotkey,
    revealApp,
  }
}
