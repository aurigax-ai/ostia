import { type FSWatcher, watch } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { debounce, throttle } from 'es-toolkit'
import type { SyncStatus } from '../../shared/types'
import { type DetectSecrets, ProfileSync } from './engine'
import { FolderMethod } from './folderMethod'
import { PROFILE_FOLDERS, SETTINGS_FILE, type SyncedExtension, isObject } from './profile'
import { expandSyncDir } from './syncDir'

const FOCUS_THROTTLE_MS = 2000
const WATCH_DEBOUNCE_MS = 800
const MARKETPLACES_FILE = 'marketplaces.json'

export interface ProfileSyncIpcDeps {
  userData: string
  configDir: string
  readSettings: () => unknown
  broadcast: (channel: string, payload?: unknown) => void
  onSettingsPulled: () => void
  installedExtensions: () => SyncedExtension[]
  builtinIds: () => string[]
  installExtension: (id: string, marketplace: string) => Promise<boolean>
  detectSecrets: DetectSecrets
}

export interface ProfileSyncHandle {
  run: () => Promise<SyncStatus>
  stop: () => void
}

export function startProfileSync(deps: ProfileSyncIpcDeps): ProfileSyncHandle {
  const configuredDir = (): string | null => {
    const settings = deps.readSettings()
    const sync = isObject(settings) && isObject(settings.sync) ? settings.sync : null
    return expandSyncDir(sync?.dir)
  }
  const sync = new ProfileSync({
    userData: deps.userData,
    configDir: deps.configDir,
    host: hostname(),
    method: () => {
      const dir = configuredDir()
      return dir ? new FolderMethod(dir, [deps.userData, deps.configDir]) : null
    },
    targetLabel: configuredDir,
    installedExtensions: deps.installedExtensions,
    builtinIds: deps.builtinIds,
    installExtension: deps.installExtension,
    detectSecrets: deps.detectSecrets,
  })
  const watchers: FSWatcher[] = []

  const run = async (): Promise<SyncStatus> => {
    try {
      const { status, pulledSettings } = await sync.run()
      if (pulledSettings) {
        deps.broadcast('settings:changed')
        deps.onSettingsPulled()
      }
      deps.broadcast('sync:status', status)
      return status
    } catch (err) {
      console.error('[sync] failed', err)
      return sync.status()
    }
  }

  const onFocus = throttle(
    () => {
      if (configuredDir()) void run()
    },
    FOCUS_THROTTLE_MS,
    { edges: ['leading'] },
  )
  const runSoon = debounce(() => void run(), WATCH_DEBOUNCE_MS)
  app.on('browser-window-focus', onFocus)

  const watchDir = (dir: string, names: Set<string> | null): void => {
    try {
      const watcher = watch(dir, (_event, file) => {
        if (names && (!file || !names.has(String(file)))) return
        runSoon()
      })
      watcher.on('error', () => {})
      watchers.push(watcher)
    } catch {}
  }
  watchDir(deps.userData, new Set([SETTINGS_FILE, MARKETPLACES_FILE]))
  for (const folder of PROFILE_FOLDERS) watchDir(join(deps.configDir, folder.name), null)

  const announced = async (status: Promise<SyncStatus>): Promise<SyncStatus> => {
    const next = await status
    deps.broadcast('sync:status', next)
    return next
  }

  ipcMain.handle('sync:status', () => sync.status())
  ipcMain.handle('sync:run', () => run())
  ipcMain.handle('sync:resolve', (_e, id: unknown) =>
    typeof id === 'string' ? announced(sync.resolve(id)) : sync.status(),
  )
  ipcMain.handle('sync:install', (_e, id: unknown) =>
    typeof id === 'string' ? announced(sync.install(id)) : sync.status(),
  )
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
      runSoon.cancel()
      for (const watcher of watchers) watcher.close()
    },
  }
}
