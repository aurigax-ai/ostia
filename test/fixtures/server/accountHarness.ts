import { DeviceSigner } from '../../../src/main/server/deviceSigner'
import { createKeyStore } from '../../../src/main/server/keyStore'
import { ServerAccount } from '../../../src/main/server/serverAccount'
import { createServerClient } from '../../../src/main/server/serverClient'
import { ServerConfig } from '../../../src/main/server/serverConfig'
import { serverRoutes } from '../../../src/main/server/serverRoutes'
import { ServerSession } from '../../../src/main/server/serverSession'
import { FakeServer, type FakeServerOptions } from './fakeServer'

export interface AccountHarness {
  server: FakeServer
  account: ServerAccount
  session: ServerSession
  saved: () => { url: string | null; identity: unknown }
  keysSaved: () => boolean
  close: () => Promise<void>
}

export async function accountHarness(
  options: FakeServerOptions & {
    url?: string
    canEncrypt?: boolean | (() => boolean)
    now?: () => number
    server?: FakeServer
  } = {},
): Promise<AccountHarness> {
  const server = options.server ?? (await new FakeServer(options).start())
  let stored: unknown = { url: options.url ?? server.url, identity: null }
  let keys: Record<string, string> | null = null
  const canEncryptOption = options.canEncrypt ?? true
  const config = new ServerConfig({
    load: () => stored,
    save: (data) => {
      stored = data
    },
    defaultUrl: () => null,
    allowInsecure: true,
  })
  const keyStore = createKeyStore({
    load: () => keys ?? {},
    save: (data) => {
      keys = data
    },
    canEncrypt: () =>
      typeof canEncryptOption === 'function' ? canEncryptOption() : canEncryptOption,
    encrypt: (plain) => Buffer.from(plain).toString('base64'),
    decrypt: (secret) => Buffer.from(secret, 'base64').toString(),
  })
  const routes = serverRoutes(
    createServerClient({ baseUrl: () => config.url(), pause: async () => {} }),
  )
  const session = new ServerSession({
    routes,
    keys: () => keyStore.load(),
    deviceId: () => config.identity()?.deviceId ?? null,
    now: options.now,
  })
  const signer = new DeviceSigner({
    keys: () => keyStore.load(),
    deviceId: () => config.identity()?.deviceId ?? null,
    now: () => server.now(),
  })
  const account = new ServerAccount({
    config,
    keyStore,
    routes,
    session,
    signer,
    deviceName: () => 'Test desktop',
    now: options.now,
  })
  return {
    server,
    account,
    session,
    saved: () => stored as { url: string | null; identity: unknown },
    keysSaved: () => keys !== null,
    close: () => (options.server ? Promise.resolve() : server.close()),
  }
}

export async function signedIn(
  options: Parameters<typeof accountHarness>[0] = {},
  code = 'invite-1',
) {
  const harness = await accountHarness(options)
  harness.server.invites.add(code)
  const result = await harness.account.signInWithInvite(code)
  if (!result.ok) throw new Error(`sign-in failed: ${result.error}`)
  return harness
}
