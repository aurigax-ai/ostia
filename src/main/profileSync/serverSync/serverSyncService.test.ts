import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeServer } from '../../../../test/fixtures/server/fakeServer'
import { firstDevice, PASSPHRASE } from '../../../../test/fixtures/server/syncHarness'
import { syncWorld } from '../../../../test/fixtures/server/syncWorld'
import { SyncKeyring } from './syncKeyring'
import { createSyncKeyStore } from './syncKeyStore'
import { readRemote } from './syncRemote'

const { world, join, track, close } = syncWorld()

const NEW_PASSPHRASE = 'a different long passphrase'

afterEach(close)

describe('key lifecycle', () => {
  it('SSY-C30 sets up once, shows the recovery key once and reports ready', async () => {
    const { first, recoveryKey } = await world()
    expect(recoveryKey).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/)
    expect((await first.service.status()).state).toBe('ready')
    const again = await first.service.setup(PASSPHRASE, PASSPHRASE)
    expect(again.ok).toBe(false)
    expect(JSON.stringify(await first.service.status())).not.toContain(recoveryKey)
  })

  it('SSY-C31 checks the passphrase length and confirmation before touching the server', async () => {
    const server = await new FakeServer().start()
    const device = await firstDevice(server)
    track(server, device)
    expect(await device.service.setup('short', 'short')).toMatchObject({ error: 'too-short' })
    expect(await device.service.setup(PASSPHRASE, `${PASSPHRASE}!`)).toMatchObject({
      error: 'mismatch',
    })
    expect((await device.service.status()).state).toBe('needs-setup')
  })

  it('SSY-C32 unlocks another device with the passphrase and rejects a wrong one', async () => {
    const { server, first } = await world()
    const other = await join(server, first, false)
    expect((await other.service.status()).state).toBe('locked')
    expect(await other.service.unlock('not the passphrase')).toMatchObject({
      ok: false,
      error: 'wrong-password',
    })
    expect((await other.service.status()).state).toBe('locked')
    expect((await other.service.unlock(PASSPHRASE)).ok).toBe(true)
    expect((await other.service.status()).state).toBe('ready')
    expect(other.keyring.key()?.equals(first.keyring.key() ?? Buffer.alloc(0))).toBe(true)
  })

  it('SSY-C33 sets a new passphrase with the recovery key in any spacing, and others keep syncing', async () => {
    const { server, first, recoveryKey } = await world()
    const other = await join(server, first, false)
    expect(await other.service.recover('AAAA-BBBB', NEW_PASSPHRASE, NEW_PASSPHRASE)).toMatchObject({
      ok: false,
      error: 'wrong-recovery-key',
    })
    const loose = recoveryKey.toLowerCase().replaceAll('-', ' ')
    expect((await other.service.recover(loose, NEW_PASSPHRASE, NEW_PASSPHRASE)).ok).toBe(true)
    expect((await other.service.status()).state).toBe('ready')
    expect((await first.service.status()).state).toBe('ready')
    const third = await join(server, first, false)
    expect((await third.service.unlock(PASSPHRASE)).ok).toBe(false)
    expect((await third.service.unlock(NEW_PASSPHRASE)).ok).toBe(true)
  })

  it('SSY-C35 wraps with 64 MiB, 3 passes and 4 lanes unless a test asks for less', async () => {
    const { first } = await world()
    const real = new SyncKeyring(
      first.account,
      createSyncKeyStore(
        { load: () => ({}), save: () => {} },
        {
          encrypt: (plain) => plain,
          decrypt: (kept) => kept,
        },
      ),
    )
    expect(real.cost).toEqual({ memoryKiB: 65_536, passes: 3, lanes: 4 })
  })

  it('SSY-C34 forgets the key when the account signs out', async () => {
    const { first } = await world()
    first.writeSettings({ locale: 'en' }, 1)
    await first.sync.run()
    const target = first.keyring.target()?.id ?? ''
    const before = first.storedKeys() as { keys: Record<string, string> }
    expect(Object.keys(before.keys)).toEqual([target])
    await first.account.signOut()
    const after = first.storedKeys() as { keys: Record<string, string>; counters: object }
    expect(after.keys).toEqual({})
    expect(Object.keys(after.counters)).toContain(target)
    expect((await first.service.status()).state).toBe('signed-out')
  })
})

describe('changing the passphrase', () => {
  it('SSY-C80 makes a new key, keeps every file and asks every other computer once', async () => {
    const { server, first, recoveryKey } = await world()
    const second = await join(server, first)
    first.writeSettings({ appearance: { theme: 'dark' } }, 1)
    await first.sync.run()
    const oldKey = first.keyring.key()
    const res = await first.service.changePassphrase(PASSPHRASE, NEW_PASSPHRASE, NEW_PASSPHRASE)
    expect(res.ok).toBe(true)
    expect(res.recoveryKey).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/)
    expect(res.recoveryKey).not.toBe(recoveryKey)
    expect(first.keyring.key()?.equals(oldKey ?? Buffer.alloc(0))).toBe(false)
    expect((await second.sync.run()).status.error).toBe('server-locked')
    expect((await second.service.status()).state).toBe('locked')
    expect((await second.service.unlock(PASSPHRASE)).ok).toBe(false)
    expect((await second.service.unlock(NEW_PASSPHRASE)).ok).toBe(true)
    await second.sync.run()
    expect(second.settings()).toMatchObject({ appearance: { theme: 'dark' } })
    const third = await join(server, first, false)
    expect((await third.service.recover(recoveryKey, PASSPHRASE, PASSPHRASE)).ok).toBe(false)
    expect((await third.service.recover(res.recoveryKey ?? '', PASSPHRASE, PASSPHRASE)).ok).toBe(
      true,
    )
  })

  it('SSY-C81 refuses a wrong current passphrase and changes nothing on the server', async () => {
    const { server, first } = await world()
    const account = first.account.identity()?.accountId ?? ''
    const before = server.syncData.get(account)?.manifests.length
    expect(
      await first.service.changePassphrase('not the passphrase', NEW_PASSPHRASE, NEW_PASSPHRASE),
    ).toMatchObject({ ok: false, error: 'wrong-password' })
    expect(await first.service.changePassphrase(PASSPHRASE, 'short', 'short')).toMatchObject({
      ok: false,
      error: 'too-short',
    })
    expect(server.syncData.get(account)?.manifests.length).toBe(before)
    expect(server.syncData.get(account)?.keyVersion).toBe(0)
  })

  it('SSY-C82 a key from a wrap must open the manifest the server serves', async () => {
    const { server, first } = await world()
    first.writeSettings({ locale: 'en' }, 1)
    await first.sync.run()
    const other = await join(server, first, false)
    const account = first.account.identity()?.accountId ?? ''
    const data = server.syncData.get(account)
    const manifest = data?.manifests.at(-1)
    if (manifest) manifest.blob = Buffer.alloc(64, 7).toString('base64url')
    expect(await other.service.unlock(PASSPHRASE)).toMatchObject({
      ok: false,
      error: 'key-differs',
    })
    expect(other.keyring.key()).toBeNull()
  })

  it('SSY-C66 carries files this client does not know through a passphrase change', async () => {
    const { first } = await world()
    const method = first.target.method()
    const read = await method.read()
    await method.write(
      new Map([
        ['settings.json', '{"a":1}\n'],
        ['future/new.json', '{"from":"a newer client"}\n'],
      ]),
      read.version,
    )
    const res = await first.service.changePassphrase(PASSPHRASE, NEW_PASSPHRASE, NEW_PASSPHRASE)
    expect(res.ok).toBe(true)
    const after = await readRemote(
      { account: first.account, keyring: first.keyring },
      undefined,
      true,
    )
    expect(after.files.get('future/new.json')?.toString()).toBe('{"from":"a newer client"}\n')
  })
})

describe('cleaning up and signing out', () => {
  it('SSY-C64 cleans up unlisted blobs after a push, once a day, on a server that binds it to the manifest', async () => {
    const { server, first } = await world({ syncGCBound: true })
    const account = server.devices.get('device1')?.accountId ?? ''
    const stored = () => server.syncData.get(account)?.blobs.size ?? 0
    const edit = async (theme: string): Promise<void> => {
      first.writeSettings({ appearance: { theme } }, server.now() / 60_000)
      await first.sync.run()
    }
    await edit('dark')
    await vi.waitFor(() =>
      expect(server.requests.some((r) => r.includes('/v1/sync/gc'))).toBe(true),
    )
    const cleaned = stored()
    await edit('light')
    await edit('dim')
    expect(stored()).toBeGreaterThan(cleaned)
    server.advance(25 * 3_600_000)
    const beforeNext = stored()
    await edit('blue')
    await vi.waitFor(() => expect(stored()).toBeLessThan(beforeNext + 1))
    expect(stored()).toBeLessThanOrEqual(cleaned)
    expect((await first.sync.run()).status.state).toBe('ok')
  })

  it('SSY-C75 never cleans up on a server that does not offer the bound route', async () => {
    const { server, first } = await world()
    const account = server.devices.get('device1')?.accountId ?? ''
    const stored = () => server.syncData.get(account)?.blobs.size ?? 0
    const edit = async (theme: string): Promise<void> => {
      first.writeSettings({ appearance: { theme } }, server.now() / 60_000)
      await first.sync.run()
    }
    await edit('dark')
    await edit('light')
    server.advance(25 * 3_600_000)
    const before = stored()
    await edit('blue')
    expect(stored()).toBeGreaterThan(before)
    expect(server.requests.some((r) => r.includes('/v1/sync/gc'))).toBe(false)
  })

  it('SSY-C71 deletes its own device from the server when it signs out', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    const id = second.account.identity()?.deviceId ?? ''
    expect(server.devices.has(id)).toBe(true)
    expect(await second.account.signOut()).toEqual({ ok: true, deviceKept: false })
    expect(server.devices.has(id)).toBe(false)
    expect(second.account.signedIn()).toBe(false)
  })

  it('SSY-C76 deletes the synced profile from the server when its last device signs out', async () => {
    const { server, first } = await world()
    first.writeSettings({ appearance: { theme: 'dark' } }, 1)
    await first.sync.run()
    const id = first.account.identity()?.deviceId ?? ''
    const account = server.devices.get(id)?.accountId ?? ''
    expect(server.syncData.get(account)?.manifests.length).toBeGreaterThan(0)
    expect(await first.account.signOut()).toEqual({ ok: true, deviceKept: false })
    expect(server.devices.has(id)).toBe(false)
    expect(server.syncData.has(account)).toBe(false)
  })

  it('SSY-C73 waits for the sign-out hooks, then deletes the device row, then ends the session', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    const id = second.account.identity()?.deviceId ?? ''
    const seen: string[] = []
    second.account.beforeSignOut(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80))
      seen.push(`hook sees the device row: ${server.devices.has(id)}`)
    })
    vi.spyOn(second.session, 'end').mockImplementation(async () => {
      seen.push(`session ends after the row left: ${!server.devices.has(id)}`)
    })
    await second.account.signOut()
    expect(seen).toEqual([
      'hook sees the device row: true',
      'session ends after the row left: true',
    ])
    expect(server.removed).toContain(id)
  })

  it('SSY-C72 lets the first device delete itself too', async () => {
    const { server, first } = await world()
    await join(server, first)
    const id = first.account.identity()?.deviceId ?? ''
    expect(await first.account.signOut()).toEqual({ ok: true, deviceKept: false })
    expect(first.account.signedIn()).toBe(false)
    expect(server.devices.has(id)).toBe(false)
  })
})
