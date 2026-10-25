import { statSync } from 'node:fs'
import { app, safeStorage } from 'electron'
import { parsePrivacySettings } from '../../shared/privacy/redaction'
import { credentials } from '../browser/credentials'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { SecretStoreDeps } from '../extensions/extensionSecrets'
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
  encryptedFile: (path: string) => SecretStoreDeps
  redactionScan: WorkerScan
  server: ServerAccount
}

export function startProfileSyncWiring({
  services,
  configDir,
  broadcast,
  encryptedFile,
  redactionScan,
  server,
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
    syncKeyFile: {
      load: () => loadJson<unknown>(syncKeyPath, {}),
      save: (data) => saveJson(syncKeyPath, data, { secure: true }),
    },
    detectSecrets: (text) =>
      redactionScan.scan(text, parsePrivacySettings(readSettingsFile().privacy).redaction.patterns),
  })
  void services.profileSync.run()
}
