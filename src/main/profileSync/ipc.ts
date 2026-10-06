import { type FSWatcher, watch } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { debounce, throttle } from 'es-toolkit'
import type { SecretActionResult, SyncStatus } from '../../shared/types'
import { type DetectSecrets, ProfileSync } from './engine'
import { FolderMethod } from './folderMethod'
import {
  PROFILE_FOLDERS,
  SECRETS_FILE,
  SETTINGS_FILE,
  type SyncedExtension,
  isObject,
} from './profile'
import { type Protect, type SecretSource, SecretSync } from './secrets'
import { expandSyncDir } from './syncDir'

const FOCUS_THROTTLE_MS = 2000
const WATCH_DEBOUNCE_MS = 800
const MARKETPLACES_FILE = 'marketplaces.json'
const SECRET_INPUT_MAX = 1024

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
  secretSources: () => SecretSource[]
  protect: Protect
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
  const method = () => {
    const dir = configuredDir()
    return dir ? new FolderMethod(dir, [deps.userData, deps.configDir]) : null
  }
  const secrets = new SecretSync({
    userData: deps.userData,
    protect: deps.protect,
    sources: deps.secretSources,
    readRemote: async () => (await method()?.read())?.files.get(SECRETS_FILE),
  })
  const sync = new ProfileSync({
    userData: deps.userData,
    configDir: deps.configDir,
    host: hostname(),
    method,
    targetLabel: configuredDir,
    installedExtensions: deps.installedExtensions,
    builtinIds: deps.builtinIds,
    installExtension: deps.installExtension,
    detectSecrets: deps.detectSecrets,
    secrets,
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
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.length <= SECRET_INPUT_MAX ? value : null
  const secretAction = (
    channel: string,
    act: (...args: string[]) => Promise<{ ok: boolean; error?: string; recoveryKey?: string }>,
    arity: number,
  ): void => {
    ipcMain.handle(channel, async (_e, ...raw: unknown[]): Promise<SecretActionResult> => {
      const args = raw.slice(0, arity).map(text)
      if (args.length < arity || args.some((a) => a === null)) {
        return { ok: false, error: 'invalid-input', status: sync.status() }
      }
      if (!configuredDir()) return { ok: false, error: 'no-target', status: sync.status() }
      const res = await act(...(args as string[]))
      const status = res.ok ? await run() : sync.status()
      return {
        ok: res.ok,
        ...(res.error ? { error: res.error } : {}),
        ...(res.recoveryKey ? { recoveryKey: res.recoveryKey } : {}),
        status,
      }
    })
  }
  const done = async (work: Promise<void>) => {
    await work
    return { ok: true }
  }
  secretAction('sync:secrets-enable', () => done(secrets.enable()), 0)
  secretAction('sync:secrets-disable', () => done(secrets.disable()), 0)
  secretAction('sync:secrets-remove', () => done(secrets.remove()), 0)
  secretAction('sync:secrets-logins', (on) => done(secrets.setLogins(on === 'on')), 1)
  secretAction('sync:secrets-setup', (pw, confirm) => secrets.setup(pw, confirm), 2)
  secretAction('sync:secrets-reset', (pw, confirm) => secrets.reset(pw, confirm), 2)
  secretAction('sync:secrets-unlock', (pw) => secrets.unlock(pw), 1)
  secretAction(
    'sync:secrets-change-password',
    (pw, confirm) => secrets.changePassword(pw, confirm),
    2,
  )
  secretAction('sync:secrets-recover', (key, pw, confirm) => secrets.recover(key, pw, confirm), 3)
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
