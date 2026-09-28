import { type FSWatcher, watch } from 'node:fs'
import { hostname } from 'node:os'
import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import type { SyncStatus } from '../shared/types'
import { EXTENSIONS_FILE, SETTINGS_FILE, SYNCED_FILES, SettingsSync } from './settingsSync'

const FOCUS_THROTTLE_MS = 2000
const WATCH_DEBOUNCE_MS = 800

export interface SettingsSyncDeps {
  userData: string
  broadcast: (channel: string, payload?: unknown) => void
  onExtensionsPulled: () => void
}

export interface SettingsSyncHandle {
  run: () => SyncStatus
  stop: () => void
}

export function startSettingsSync(deps: SettingsSyncDeps): SettingsSyncHandle {
  const sync = new SettingsSync({ userData: deps.userData, host: hostname() })
  let lastFocusRun = 0
  let watchTimer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null
  let running = false

  const run = (): SyncStatus => {
    if (running) return sync.status()
    running = true
    try {
      const { status, pulled } = sync.run()
      if (pulled.includes(SETTINGS_FILE)) deps.broadcast('settings:changed')
      if (pulled.includes(EXTENSIONS_FILE)) deps.onExtensionsPulled()
      deps.broadcast('sync:status', status)
      return status
    } catch (err) {
      console.error('[sync] failed', err)
      return sync.status()
    } finally {
      running = false
    }
  }

  const onFocus = (): void => {
    const now = Date.now()
    if (now - lastFocusRun < FOCUS_THROTTLE_MS) return
    lastFocusRun = now
    if (sync.configuredDir()) run()
  }
  app.on('browser-window-focus', onFocus)

  const names = new Set(SYNCED_FILES.map((f) => f.name))
  try {
    watcher = watch(deps.userData, (_event, file) => {
      if (!file || !names.has(String(file))) return
      if (watchTimer) clearTimeout(watchTimer)
      watchTimer = setTimeout(() => {
        watchTimer = null
        run()
      }, WATCH_DEBOUNCE_MS)
    })
    watcher.on('error', () => {})
  } catch (err) {
    console.error('[sync] cannot watch settings dir', err)
  }

  ipcMain.handle('sync:status', () => sync.status())
  ipcMain.handle('sync:run', () => run())
  ipcMain.handle('dialog:pick-folder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
    }
    const res = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  return {
    run,
    stop: () => {
      app.off('browser-window-focus', onFocus)
      if (watchTimer) clearTimeout(watchTimer)
      watcher?.close()
    },
  }
}
