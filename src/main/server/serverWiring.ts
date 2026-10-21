import { app, safeStorage } from 'electron'
import { friendlyName } from '../gateway/route'
import { loadJson, saveJson, storePath } from '../platform/jsonStore'
import { runningBuild } from '../updates/appVersion'
import type { WindowSend } from '../windows/windowSend'
import { DeviceSigner } from './deviceSigner'
import { createKeyStore } from './keyStore'
import { ServerAccount } from './serverAccount'
import { createServerClient } from './serverClient'
import { ServerConfig } from './serverConfig'
import { ServerDevices } from './serverDevices'
import { ServerElevation } from './serverElevation'
import { registerServerIpc } from './serverIpc'
import { serverRoutes } from './serverRoutes'
import { ServerSession } from './serverSession'
import { defaultServerUrl } from './serverUrl'

interface ServerStartDeps {
  broadcast: WindowSend['broadcast']
  openExternalSafe: (url: string) => boolean
}

function encryptedKeys() {
  const path = storePath('server-keys', 'global')
  return createKeyStore({
    load: () => loadJson<unknown>(path, {}),
    save: (data) => saveJson(path, data ?? {}, { secure: true }),
    canEncrypt: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (secret) => safeStorage.decryptString(Buffer.from(secret, 'base64')),
  })
}

export function startServer({ broadcast, openExternalSafe }: ServerStartDeps): ServerAccount {
  const configPath = storePath('server-config', 'global')
  const allowInsecure = !app.isPackaged
  const config = new ServerConfig({
    load: () => loadJson<unknown>(configPath, {}),
    save: (data) => saveJson(configPath, data, { secure: true }),
    defaultUrl: () => defaultServerUrl(app.isPackaged, process.env, runningBuild()?.server),
    allowInsecure,
  })
  const keyStore = encryptedKeys()
  const routes = serverRoutes(createServerClient({ baseUrl: () => config.url() }))
  const session = new ServerSession({
    routes,
    keys: () => keyStore.load(),
    deviceId: () => config.identity()?.deviceId ?? null,
  })
  const signer = new DeviceSigner({
    keys: () => keyStore.load(),
    deviceId: () => config.identity()?.deviceId ?? null,
  })
  const account = new ServerAccount({
    config,
    keyStore,
    routes,
    session,
    signer,
    deviceName: () => friendlyName(),
  })
  account.onChange(() => broadcast('server:changed', account.status()))
  account.onDevicesChanged(() => broadcast('server:devices-changed', null))
  registerServerIpc({
    account,
    devices: new ServerDevices(account),
    elevation: new ServerElevation(account),
    allowInsecure,
    openExternal: openExternalSafe,
  })
  return account
}
