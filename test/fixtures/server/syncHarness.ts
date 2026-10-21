import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ProfileSync } from '../../../src/main/profileSync/engine'
import { createServerTarget } from '../../../src/main/profileSync/serverSync/serverMethod'
import { ServerSyncService } from '../../../src/main/profileSync/serverSync/serverSyncService'
import { SyncKeyring } from '../../../src/main/profileSync/serverSync/syncKeyring'
import { createSyncKeyStore } from '../../../src/main/profileSync/serverSync/syncKeyStore'
import { ServerDevices } from '../../../src/main/server/serverDevices'
import { ServerElevation } from '../../../src/main/server/serverElevation'
import { type AccountHarness, accountHarness, signedIn } from './accountHarness'
import type { FakeServer } from './fakeServer'

const FAST_ARGON = { memoryKiB: 1024, passes: 1, lanes: 1 }

export const PASSPHRASE = 'a long passphrase for tests'

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 6, 12, minute))

export interface SyncDevice extends AccountHarness {
  keyring: SyncKeyring
  target: ReturnType<typeof createServerTarget>
  sync: ProfileSync
  devices: ServerDevices
  service: ServerSyncService
  elevation: ServerElevation
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
  const keyring = new SyncKeyring(harness.account, keyStore, FAST_ARGON)
  const target = createServerTarget(harness.account, keyring)
  const local = localProfile(mkdtempSync(join(tmpdir(), 'sync-device-')))
  const clock = { now: at(0) }
  const sync = new ProfileSync({
    userData: local.userData,
    configDir: local.configDir,
    now: () => clock.now,
    method: () => target.method(),
    targetLabel: () => target.label(),
    installedExtensions: () => [],
    builtinIds: () => [],
    installExtension: async () => true,
    detectSecrets: async () => [],
  })
  const devices = new ServerDevices(harness.account)
  return {
    ...harness,
    ...local,
    keyring,
    storedKeys: () => stored,
    target,
    sync,
    devices,
    service: new ServerSyncService({ account: harness.account, keyring, devices }),
    elevation: new ServerElevation(harness.account),
  }
}

export async function firstDevice(server: FakeServer): Promise<SyncDevice> {
  const harness = await signedIn({ server }, `admin-${server.devices.size}`)
  return assemble(harness)
}

export async function elevate(requester: SyncDevice, approver: SyncDevice): Promise<void> {
  const started = await requester.elevation.start('approval')
  if (!started.ok) throw new Error(`elevation failed: ${started.error}`)
  const asked = await approver.elevation.approvals()
  if (!asked.ok) throw new Error(`approvals failed: ${asked.error}`)
  const approved = await approver.elevation.approve(asked.approvals[0]?.id ?? '')
  if (!approved.ok) throw new Error(`approve failed: ${approved.error}`)
  const polled = await requester.elevation.poll()
  if (polled.state !== 'done') throw new Error('elevation did not finish')
}

export async function joinedDevice(
  server: FakeServer,
  inviter: SyncDevice,
  approver?: SyncDevice,
): Promise<SyncDevice> {
  let invite = await inviter.devices.createInvite()
  if (!invite.ok && invite.error === 'elevation-required' && approver) {
    await elevate(inviter, approver)
    invite = await inviter.devices.createInvite()
  }
  if (!invite.ok) throw new Error(`invite failed: ${invite.error}`)
  const harness = await accountHarness({ server })
  const result = await harness.account.signInWithInvite(invite.code)
  if (!result.ok) throw new Error(`join failed: ${result.error}`)
  return assemble(harness)
}

export async function setUp(device: SyncDevice): Promise<string> {
  const result = await device.keyring.setup(PASSPHRASE, PASSPHRASE)
  if (!result.ok) throw new Error(`setup failed: ${result.error}`)
  return result.recoveryKey
}
