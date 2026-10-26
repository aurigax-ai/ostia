import { type FSWatcher, watch } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { debounce, throttle } from 'es-toolkit'
import type { SecretActionResult, SyncStatus } from '../../shared/profileSync/profileSync'
import { parseSyncKinds } from '../../shared/profileSync/syncKinds'
import type { ServerAccount } from '../server/serverAccount'
import { type DetectSecrets, ProfileSync } from './engine'
import { FolderMethod } from './folderMethod'
import { PROFILE_FOLDERS, SECRETS_FILE, SETTINGS_FILE, type SyncedExtension } from './profile'
import { rekeyBundle } from './secretCrypto'
import { type Protect, type SecretSource, SecretSync } from './secrets'
import { createServerTarget } from './serverSync/serverMethod'
import { registerServerSyncIpc } from './serverSync/serverSyncIpc'
import { ServerSyncService } from './serverSync/serverSyncService'
import { SyncKeyring } from './serverSync/syncKeyring'
import { createSyncKeyStore, type SyncKeyFile } from './serverSync/syncKeyStore'
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
  server: ServerAccount
  syncKeyFile: SyncKeyFile
}

export interface ProfileSyncHandle {
  run: () => Promise<SyncStatus>
  stop: () => void
}

export function startProfileSync(deps: ProfileSyncIpcDeps): ProfileSyncHandle {
  const syncSettings = (): Record<string, unknown> | null => {
    const settings = deps.readSettings()
    return isRecord(settings) && isRecord(settings.sync) ? settings.sync : null
  }
  const serverChosen = (): boolean => syncSettings()?.method === 'server'
  const configuredDir = (): string | null => expandSyncDir(syncSettings()?.dir)
  const keyring = new SyncKeyring(deps.server, createSyncKeyStore(deps.syncKeyFile, deps.protect))
  const serverTarget = createServerTarget(deps.server, keyring)
  const enabled = (): boolean => serverChosen() || configuredDir() !== null
  const targetLabel = (): string | null => (serverChosen() ? serverTarget.label() : configuredDir())
  const method = () => {
    if (serverChosen()) return serverTarget.method()
    const dir = configuredDir()
    return dir ? new FolderMethod(dir, [deps.userData, deps.configDir]) : null
  }
  const secrets = new SecretSync({
    userData: deps.userData,
    protect: deps.protect,
    sources: deps.secretSources,
    readRemote: async () => (await method()?.read())?.files.get(SECRETS_FILE),
    syncKey: () => (serverChosen() ? keyring.key() : null),
  })
  const sync = new ProfileSync({
    userData: deps.userData,
    configDir: deps.configDir,
    method,
    targetLabel,
    kinds: () => parseSyncKinds(syncSettings()?.kinds),
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
      if (enabled()) void run()
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

  const serverSync = new ServerSyncService({
    account: deps.server,
    keyring,
    rekey: (path, content, from, to) =>
      path === SECRETS_FILE
        ? Buffer.from(rekeyBundle(content.toString('utf8'), from, to), 'utf8')
        : content,
  })
  registerServerSyncIpc({
    service: serverSync,
    run,
    broadcast: deps.broadcast,
  })
  deps.server.onChange(() => {
    if (serverChosen()) void run()
  })

  ipcMain.handle('sync:status', () => sync.status())
  ipcMain.handle('sync:run', () => run())
  ipcMain.handle('sync:install', async (_e, id: unknown) => {
    if (typeof id !== 'string') return sync.status()
    const next = await sync.install(id)
    deps.broadcast('sync:status', next)
    return next
  })
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
      if (!enabled()) return { ok: false, error: 'no-target', status: sync.status() }
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
  secretAction('sync:secrets-use-sync-key', () => secrets.useSyncKey(), 0)
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
