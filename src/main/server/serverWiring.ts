import { hostname } from 'node:os'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { app, safeStorage } from 'electron'
import { loadJson, saveJson, storePath } from '../platform/jsonStore'
import type { WindowSend } from '../windows/windowSend'
import { runningBuild } from '../updates/appVersion'
import { createKeyStore } from './keyStore'
import { ServerAccount } from './serverAccount'
import { createServerClient } from './serverClient'
import { ServerConfig } from './serverConfig'
import { registerServerIpc } from './serverIpc'
import { serverRoutes } from './serverRoutes'
import { ServerSession } from './serverSession'
import { parseServerUrl } from './serverUrl'

export const SERVER_URL_ENV = 'SERVER_URL'

interface ServerStartDeps {
  broadcast: WindowSend['broadcast']
  openExternalSafe: (url: string) => boolean
}

export function defaultServerUrl(
  isPackaged: boolean,
  env: Record<string, string | undefined>,
  stamp: string | undefined,
): string | null {
  const override = isPackaged ? undefined : readEnv(SERVER_URL_ENV, env)
  const text = override ?? stamp
  return text ? parseServerUrl(text, !isPackaged) : null
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
  const account = new ServerAccount({
    config,
    keyStore,
    routes,
    session,
    deviceName: () => hostname(),
  })
  account.onChange(() => broadcast('server:changed', account.status()))
  registerServerIpc({ account, allowInsecure, openExternal: openExternalSafe })
  return account
}
