import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ProfileSync } from '../../../src/main/profileSync/engine'
import { SECRETS_FILE } from '../../../src/main/profileSync/profile'
import { rekeyBundle } from '../../../src/main/profileSync/secretCrypto'
import { createServerTarget } from '../../../src/main/profileSync/serverSync/serverMethod'
import { ServerSyncService } from '../../../src/main/profileSync/serverSync/serverSyncService'
import { SyncKeyring } from '../../../src/main/profileSync/serverSync/syncKeyring'
import { createSyncKeyStore } from '../../../src/main/profileSync/serverSync/syncKeyStore'
import { type AccountHarness, accountHarness, signedIn } from './accountHarness'
import type { FakeServer } from './fakeServer'

const FAST_ARGON = { memoryKiB: 1024, passes: 1, lanes: 1 }

export const PASSPHRASE = 'a long passphrase for tests'

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 6, 12, minute))

export interface SyncDevice extends AccountHarness {
  keyring: SyncKeyring
  target: ReturnType<typeof createServerTarget>
  sync: ProfileSync
  service: ServerSyncService
  userData: string
  configDir: string
  storedKeys: () => unknown
  writeSettings: (value: unknown, minute: number) => void
  settings: () => Record<string, unknown>
  writeFile: (rel: string, text: string, minute: number) => void
  file: (rel: string) => string | null
}

function localProfile(root: string) {
  const userData = join(root, 'data')
  const configDir = join(root, 'config')
  mkdirSync(userData, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  const stamp = (path: string, minute: number): void => utimesSync(path, at(minute), at(minute))
  return {
    userData,
    configDir,
    writeSettings: (value: unknown, minute: number): void => {
      const path = join(userData, 'settings.json')
      writeFileSync(path, JSON.stringify(value))
      stamp(path, minute)
    },
    settings: (): Record<string, unknown> =>
      JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')),
    writeFile: (rel: string, text: string, minute: number): void => {
      const path = join(configDir, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
      stamp(path, minute)
    },
    file: (rel: string): string | null => {
      try {
        return readFileSync(join(configDir, rel), 'utf8')
      } catch {
        return null
      }
    },
  }
}

function assemble(harness: AccountHarness): SyncDevice {
  let stored: unknown = {}
  const keyStore = createSyncKeyStore(
    { load: () => stored, save: (data) => (stored = data) },
    {
      encrypt: (plain) => Buffer.from(plain).toString('base64'),
      decrypt: (kept) => Buffer.from(kept, 'base64').toString(),
    },
  )
  const keyring = new SyncKeyring(harness.account, keyStore, FAST_ARGON, () => harness.server.now())
  const target = createServerTarget(harness.account, keyring)
  const local = localProfile(mkdtempSync(join(tmpdir(), 'sync-device-')))
  const clock = { now: at(0) }
  const sync = new ProfileSync({
    userData: local.userData,
    configDir: local.configDir,
    now: () => clock.now,
    method: () => target.method(),
    targetLabel: () => target.label(),
    detectSecrets: async () => [],
  })
  return {
    ...harness,
    ...local,
    keyring,
    storedKeys: () => stored,
    target,
    sync,
    service: new ServerSyncService({
      account: harness.account,
      keyring,
      rekey: (path, content, from, to) =>
        path === SECRETS_FILE
          ? Buffer.from(rekeyBundle(content.toString('utf8'), from, to), 'utf8')
          : content,
    }),
  }
}

export async function firstDevice(server: FakeServer): Promise<SyncDevice> {
  const harness = await signedIn({ server }, `admin-${server.devices.size}`)
  return assemble(harness)
}

export async function joinedDevice(server: FakeServer, of: SyncDevice): Promise<SyncDevice> {
  const accountId = of.account.identity()?.accountId
  if (!accountId) throw new Error('the first device is not signed in')
  const code = `join-${server.devices.size}`
  server.accountInvites.set(code, accountId)
  const harness = await accountHarness({ server })
  const result = await harness.account.signInWithInvite(code)
  if (!result.ok) throw new Error(`join failed: ${result.error}`)
  return assemble(harness)
}

export async function setUp(device: SyncDevice): Promise<string> {
  const result = await device.service.setup(PASSPHRASE, PASSPHRASE)
  if (!result.ok || !result.recoveryKey) throw new Error(`setup failed: ${result.error}`)
  return result.recoveryKey
}
