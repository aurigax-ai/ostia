import { statSync } from 'node:fs'
import { app, type BrowserWindow, safeStorage } from 'electron'
import { type Dict, fmt } from '../../shared/app/dict'
import { parsePrivacySettings } from '../../shared/privacy/redaction'
import type { SyncAttention } from '../../shared/profileSync/serverSync'
import { postActionNotification } from '../attention/notify'
import type { NotifyWiring } from '../attention/notifyWiring'
import { credentials } from '../browser/credentials'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { SecretStoreDeps } from '../extensions/extensionSecrets'
import type { Marketplace } from '../extensions/marketplace/marketplace'
import { loadJson, saveJson, storePath } from '../platform/jsonStore'
import { readSettingsFile } from '../platform/settingsFile'
import type { WorkerScan } from '../privacy/redactionScan'
import type { ServerAccount } from '../server/serverAccount'
import type { WindowSend } from '../windows/windowSend'
import { type ProfileSyncHandle, startProfileSync } from './ipc'
import { flatSource, groupedSource, loginsSource } from './secretSources'

interface ProfileSyncStartDeps {
  services: {
    extensionHost: ExtensionHost | null
    profileSync: ProfileSyncHandle | null
  }
  configDir: () => string
  broadcast: WindowSend['broadcast']
  marketplace: Marketplace
  encryptedFile: (path: string) => SecretStoreDeps
  redactionScan: WorkerScan
  server: ServerAccount
  mainStrings: () => Dict
  notifyDeps: NotifyWiring['notifyDeps']
  windows: Map<string, BrowserWindow>
}

function attentionText(
  text: Dict['native']['syncAttention'],
  item: SyncAttention,
): { title: string; body: string } {
  switch (item.kind) {
    case 'join':
      return { title: text.join.title, body: fmt(text.join.body, { name: item.name }) }
    case 'approval':
      return { title: text.approval.title, body: fmt(text.approval.body, { name: item.name }) }
    case 'changed':
      return {
        title: text.changed.title,
        body: fmt(text.changed.body, { name: item.name }),
      }
  }
}

export function startProfileSyncWiring({
  services,
  configDir,
  broadcast,
  marketplace,
  encryptedFile,
  redactionScan,
  server,
  mainStrings,
  notifyDeps,
  windows,
}: ProfileSyncStartDeps) {
  const syncKeyPath = storePath('sync-server', 'global')
  services.profileSync = startProfileSync({
    userData: app.getPath('userData'),
    configDir: configDir(),
    readSettings: readSettingsFile,
    broadcast: (channel, payload) => broadcast(channel, payload),
    onSettingsPulled: () => {
      services.extensionHost?.config.reloadSettings()
      services.extensionHost?.refreshLocale()
    },
    installedExtensions: () => marketplace.syncedInstalls(),
    builtinIds: () =>
      services.extensionHost
        ?.list()
        .filter((ext) => ext.builtin)
        .map((ext) => ext.id) ?? [],
    installExtension: async (id, url) => (await marketplace.installSuggested(id, url, true)).ok,
    secretSources: () => {
      const store = (name: string) => {
        const path = storePath(name, 'global')
        return { deps: encryptedFile(path), mtime: () => statSync(path).mtimeMs }
      }
      const vault = store('vault')
      const ext = store('extension-secrets')
      const assist = store('assist-keys')
      const mcp = store('mcp-secrets')
      const logins = credentials()
      return [
        flatSource(vault.deps, vault.mtime),
        groupedSource('extensions', ext.deps, ext.mtime),
        groupedSource('assistant', assist.deps, assist.mtime),
        groupedSource('mcp', mcp.deps, mcp.mtime),
        ...(logins ? [loginsSource(logins)] : []),
      ]
    },
    protect: {
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (kept) => safeStorage.decryptString(Buffer.from(kept, 'base64')),
    },
    server,
    notifyAttention: (item) =>
      postActionNotification(
        notifyDeps,
        { ...attentionText(mainStrings().native.syncAttention, item), from: 'sync' },
        () => {
          const win = [...windows.values()].find((w) => !w.isDestroyed())
          if (!win) return
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
          win.webContents.send('syncServer:open', item.kind === 'join' ? 'sync' : 'server')
        },
      ),
    syncKeyFile: {
      load: () => loadJson<unknown>(syncKeyPath, {}),
      save: (data) => saveJson(syncKeyPath, data, { secure: true }),
    },
    detectSecrets: (text) =>
      redactionScan.scan(text, parsePrivacySettings(readSettingsFile().privacy).redaction.patterns),
  })
  void services.profileSync.run()
}
