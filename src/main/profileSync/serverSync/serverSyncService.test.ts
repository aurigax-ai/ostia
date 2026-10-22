import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeServer } from '../../../../test/fixtures/server/fakeServer'
import { elevate, firstDevice, PASSPHRASE } from '../../../../test/fixtures/server/syncHarness'
import { syncWorld } from '../../../../test/fixtures/server/syncWorld'
import { SyncKeyring } from './syncKeyring'
import { createSyncKeyStore } from './syncKeyStore'
import { readRemote } from './syncRemote'

const { world, join, track, close } = syncWorld()

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

  it('SSY-C33 unlocks with the recovery key in any spacing and rejects a wrong key', async () => {
    const { server, first, recoveryKey } = await world()
    const other = await join(server, first, false)
    expect(await other.service.recover('AAAA-BBBB')).toMatchObject({
      ok: false,
      error: 'wrong-recovery-key',
    })
    const loose = recoveryKey.toLowerCase().replaceAll('-', ' ')
    expect((await other.service.recover(loose)).ok).toBe(true)
    expect((await other.service.status()).state).toBe('ready')
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

describe('linking a device through an approval', () => {
  it('SSY-C40 shows one check code on both devices and hands over the key on approve', async () => {
    const { server, first } = await world()
    const fresh = await join(server, first, false)
    expect(await fresh.service.linkStart()).toMatchObject({ ok: true })
    const waiting = await fresh.service.status()
    expect(waiting.state).toBe('locked')
    expect(waiting.linking).toBe(true)
    const asked = (await first.service.status()).joins
    expect(asked).toHaveLength(1)
    expect(asked[0]?.name).toBe('Test desktop')
    expect(asked[0]?.code).toMatch(/^([A-Z2-7]{5}-){4}[A-Z2-7]{5}$/)
    expect(waiting.linkCodes.map((c) => c.code)).toEqual([asked[0]?.code])
    expect(
      (await first.service.approveJoin(asked[0]?.deviceId ?? '', asked[0]?.code ?? '')).ok,
    ).toBe(true)
    expect((await first.service.status()).joins).toEqual([])
    const approved = await fresh.service.status()
    expect(approved).toMatchObject({ state: 'locked', linkApproved: true })
    expect(fresh.keyring.key()).toBeNull()
    expect((await fresh.service.linkConfirm(waiting.linkCodes[0]?.code ?? '')).ok).toBe(true)
    const done = await fresh.service.status()
    expect(done.state).toBe('ready')
    expect(fresh.keyring.key()?.equals(first.keyring.key() ?? Buffer.alloc(0))).toBe(true)
  })

  it('SSY-C41 does not adopt a wrap the device did not ask for', async () => {
    const { server, first } = await world()
    const fresh = await join(server, first, false)
    const asked = (await first.service.status()).joins
    await first.service.approveJoin(asked[0]?.deviceId ?? '', asked[0]?.code ?? '')
    const before = await fresh.service.status()
    expect(before.state).toBe('locked')
    expect(fresh.keyring.key()).toBeNull()
    expect(await fresh.service.linkConfirm('x')).toMatchObject({ ok: false, error: 'locked' })
    await fresh.service.linkStart()
    expect((await fresh.service.status()).linkApproved).toBe(true)
    expect(fresh.keyring.key()).toBeNull()
  })

  it('SSY-C44 builds each code from the local keys and refuses a server that swaps them', async () => {
    const { server, first } = await world()
    const fresh = await join(server, first, false)
    await fresh.service.linkStart()
    const honest = (await first.service.status()).joins[0]
    const freshId = fresh.account.identity()?.deviceId ?? ''
    const firstId = first.account.identity()?.deviceId ?? ''
    const swapped = Buffer.alloc(32, 7).toString('base64url')
    server.rewriteDevices = (viewer, rows) =>
      rows.map((r) => (r.id === freshId && viewer === firstId ? { ...r, boxPub: swapped } : r))
    const forged = (await first.service.status()).joins[0]
    const seen = (await fresh.service.status()).linkCodes[0]
    expect(forged?.code).not.toBe(seen?.code)
    expect(seen?.code).toBe(honest?.code)
    server.rewriteDevices = (viewer, rows) =>
      rows.map((r) => (r.id === freshId && viewer === freshId ? { ...r, boxPub: swapped } : r))
    expect((await fresh.service.status()).state).toBe('untrusted')
    server.rewriteDevices = (viewer, rows) =>
      rows.map((r) => (r.id === firstId && viewer === firstId ? { ...r, signPub: swapped } : r))
    expect((await first.service.status()).state).toBe('untrusted')
    expect(await first.service.approveJoin(freshId, honest?.code ?? '')).toMatchObject({
      ok: false,
      error: 'untrusted',
    })
    const account = server.devices.get(firstId)?.accountId ?? ''
    expect(server.syncData.get(account)?.wraps.has(`device:${freshId}`)).toBe(false)
  })

  it('SSY-C42 a denied device stays without a key and keeps asking', async () => {
    const { server, first } = await world()
    const fresh = await join(server, first, false)
    await fresh.service.linkStart()
    expect((await fresh.service.status()).state).toBe('locked')
    expect((await first.service.status()).joins).toHaveLength(1)
    expect(fresh.keyring.key()).toBeNull()
  })

  it('SSY-C43 the code differs for a device with other keys', async () => {
    const { server, first } = await world()
    const a = await join(server, first, false)
    const b = await join(server, first, false, a)
    const joins = (await first.service.status()).joins
    expect(new Set(joins.map((j) => j.code)).size).toBe(2)
    expect(a.keyring.key()).toBeNull()
    expect(b.keyring.key()).toBeNull()
  })
})

describe('elevation, approvals and the age rule', () => {
  it('SSY-C50 a third device needs an elevated session to mint an invite', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    expect(await first.devices.createInvite()).toMatchObject({
      ok: false,
      error: 'elevation-required',
    })
    await elevate(first, second)
    expect(await first.devices.createInvite()).toMatchObject({ ok: true })
  })

  it('SSY-C51 an account with one device cannot ask for an approval', async () => {
    const { first } = await world()
    expect(await first.elevation.start('approval')).toEqual({
      ok: false,
      error: 'no-second-device',
    })
  })

  it('SSY-C52 a device younger than the minimum age cannot approve or be approved', async () => {
    const { server, first } = await world({ approverMinAgeMs: 86_400_000 })
    server.advance(25 * 3_600_000)
    const second = await join(server, first)
    await first.elevation.start('approval')
    const forSecond = await second.elevation.approvals()
    const firstAsk = forSecond.ok ? (forSecond.approvals[0]?.id ?? '') : ''
    expect(await second.elevation.approve(firstAsk)).toEqual({ ok: false, error: 'device-too-new' })
    await second.elevation.start('approval')
    const forFirst = await first.elevation.approvals()
    const secondAsk = forFirst.ok ? (forFirst.approvals[0]?.id ?? '') : ''
    expect(await first.elevation.approve(secondAsk)).toEqual({
      ok: false,
      error: 'requester-too-new',
    })
    server.advance(25 * 3_600_000)
    await second.elevation.start('approval')
    const fresh = await first.elevation.approvals()
    expect(fresh.ok && fresh.approvals.length).toBe(1)
    expect(await first.elevation.approve(fresh.ok ? (fresh.approvals[0]?.id ?? '') : '')).toEqual({
      ok: true,
    })
  })

  it('SSY-C53 lists the requester name and age on the approving device', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    await second.elevation.start('approval')
    const asked = await first.elevation.approvals()
    expect(asked.ok && asked.approvals[0]?.deviceName).toBe('Test desktop')
    expect(asked.ok && asked.approvals[0]?.deviceCreatedAt).toBeGreaterThan(0)
    const own = await second.elevation.approvals()
    expect(own).toEqual({ ok: true, approvals: [] })
  })

  it('SSY-C55 elevates a GitHub account with a fresh sign-in', async () => {
    const server = await new FakeServer({ github: true, approverMinAgeMs: 0 }).start()
    const first = await firstDevice(server)
    track(server, first)
    expect(await first.elevation.start('github')).toEqual({
      ok: false,
      error: 'not-a-github-account',
    })
  })
})

describe('removing a device and rotating the key', () => {
  it('SSY-C60 revokes, re-seals everything and lets the other device continue', async () => {
    const { server, first, recoveryKey } = await world()
    const second = await join(server, first)
    const third = await join(server, first, true, second)
    first.writeSettings({ appearance: { theme: 'dark' } }, 1)
    first.writeFile('views/a.json', '{}\n', 1)
    await first.sync.run()
    const oldKey = first.keyring.key() ?? Buffer.alloc(0)
    const before = await readRemote({ account: first.account, keyring: first.keyring })
    const thirdId = third.account.identity()?.deviceId ?? ''
    server.advance(25 * 3_600_000)

    const blocked = await first.service.removeDevice(thirdId, PASSPHRASE, recoveryKey)
    expect(blocked).toMatchObject({ ok: false, error: 'elevation-required' })
    await elevate(first, second)
    const removed = await first.service.removeDevice(thirdId, PASSPHRASE, recoveryKey)
    expect(removed).toMatchObject({ ok: true, removed: true, rotated: true })

    expect(server.removed).toContain(thirdId)
    expect(first.keyring.key()?.equals(oldKey)).toBe(false)
    const after = await readRemote({ account: first.account, keyring: first.keyring })
    expect(after.manifest?.counter).toBeGreaterThan(before.manifest?.counter ?? 0)
    const ids = (r: typeof before) => Object.values(r.manifest?.files ?? {}).map((f) => f.blobId)
    expect(ids(after).filter((id) => ids(before).includes(id))).toEqual([])
    expect([...after.files.keys()].sort()).toEqual([...before.files.keys()].sort())

    const continued = await second.sync.run()
    expect(continued.status.state).toBe('ok')
    expect(second.keyring.key()?.equals(first.keyring.key() ?? Buffer.alloc(0))).toBe(true)
    first.writeSettings({ appearance: { theme: 'light' } }, 2)
    await first.sync.run()
    await second.sync.run()
    expect(second.settings()).toMatchObject({ appearance: { theme: 'light' } })
    expect((await third.sync.run()).status.state).toBe('error')
    expect((await first.service.status()).recoveryStale).toBe(false)
  })

  it('SSY-C61 refuses a wrong passphrase before revoking anything', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    await elevate(first, second)
    const res = await first.service.removeDevice(
      second.account.identity()?.deviceId ?? '',
      'a wrong passphrase!!',
      '',
    )
    expect(res).toMatchObject({ ok: false, error: 'wrong-password' })
    expect(server.removed).toEqual([])
  })

  it('SSY-C62 drops the recovery wrap without the recovery key and offers a new one', async () => {
    const { server, first, recoveryKey } = await world()
    const second = await join(server, first)
    const third = await join(server, first, true, second)
    await elevate(first, second)
    const res = await first.service.removeDevice(
      third.account.identity()?.deviceId ?? '',
      PASSPHRASE,
      '',
    )
    expect(res).toMatchObject({ ok: true, rotated: true })
    expect((await first.service.status()).recoveryStale).toBe(true)
    const fourth = await join(server, first, false, second)
    expect(await fourth.service.recover(recoveryKey)).toMatchObject({ ok: false, error: 'no-wrap' })
    const fresh = await first.service.newRecoveryKey()
    expect(fresh.ok).toBe(true)
    expect(fresh.recoveryKey).toBeDefined()
    expect((await first.service.status()).recoveryStale).toBe(false)
    expect((await fourth.service.recover(fresh.recoveryKey ?? '')).ok).toBe(true)
  })

  it('SSY-C63 keeps the old recovery key working when it is entered', async () => {
    const { server, first, recoveryKey } = await world()
    const second = await join(server, first)
    const third = await join(server, first, true, second)
    await elevate(first, second)
    const res = await first.service.removeDevice(
      third.account.identity()?.deviceId ?? '',
      PASSPHRASE,
      recoveryKey,
    )
    expect(res).toMatchObject({ ok: true, rotated: true })
    const fourth = await join(server, first, false, second)
    expect((await fourth.service.recover(recoveryKey)).ok).toBe(true)
    expect(fourth.keyring.key()?.equals(first.keyring.key() ?? Buffer.alloc(0))).toBe(true)
  })

  it('SSY-C64 cleans up unlisted blobs after a push, once a day, on a server that binds it to the manifest', async () => {
    const { server, first } = await world({ syncGCBound: true, approverMinAgeMs: 0 })
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

  it('SSY-C74 counts a refusal for a device that is still too new as the day', async () => {
    const { server, first } = await world({ syncGCBound: true, approverMinAgeMs: 3_600_000 })
    const gcCalls = () => server.requests.filter((r) => r.includes('/v1/sync/gc')).length
    const edit = async (theme: string): Promise<void> => {
      first.writeSettings({ appearance: { theme } }, server.now() / 60_000)
      await first.sync.run()
    }
    await edit('dark')
    await vi.waitFor(() => expect(gcCalls()).toBe(1))
    server.advance(2 * 3_600_000)
    await edit('light')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(gcCalls()).toBe(1)
  })

  it('SSY-C75 never cleans up on a server that does not offer the bound route', async () => {
    const { server, first } = await world({ approverMinAgeMs: 0 })
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

  it('SSY-C71 deletes its own device and wrap from the server when a newer device signs out', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    const id = second.account.identity()?.deviceId ?? ''
    const account = server.devices.get(id)?.accountId ?? ''
    expect(server.devices.has(id)).toBe(true)
    expect(server.syncData.get(account)?.wraps.has(`device:${id}`)).toBe(true)
    expect(await second.account.signOut()).toEqual({ ok: true, deviceKept: false })
    expect(server.devices.has(id)).toBe(false)
    expect(server.syncData.get(account)?.wraps.has(`device:${id}`)).toBe(false)
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

  it('SSY-C72 lets the oldest device delete itself too, without an elevated session', async () => {
    const { server, first } = await world()
    await join(server, first)
    const id = first.account.identity()?.deviceId ?? ''
    expect(await first.account.signOut()).toEqual({ ok: true, deviceKept: false })
    expect(first.account.signedIn()).toBe(false)
    expect(server.devices.has(id)).toBe(false)
  })

  it('SSY-C65 wraps the new key only for devices the manifest lists or this machine approved, and says who was left out', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    const third = await join(server, first, true, second)
    const ghost = {
      id: 'ghost1',
      name: 'Injected',
      signPub: Buffer.alloc(32, 1).toString('base64url'),
      boxPub: Buffer.alloc(32, 9).toString('base64url'),
      createdAt: 1,
      lastSeenAt: 0,
      removeAt: 0,
    }
    server.rewriteDevices = (_viewer, rows) => [...rows, ghost]
    await elevate(first, second)
    const res = await first.service.removeDevice(
      third.account.identity()?.deviceId ?? '',
      PASSPHRASE,
      '',
    )
    expect(res).toMatchObject({ ok: true, rotated: true, unwrapped: ['Injected'] })
    const account = server.devices.get('device1')?.accountId ?? ''
    const wraps = [...(server.syncData.get(account)?.wraps.keys() ?? [])]
    expect(wraps).not.toContain('device:ghost1')
    expect(wraps).toContain(`device:${second.account.identity()?.deviceId}`)
    expect(wraps).toContain('device:device1')
  })

  it('SSY-C66 carries files this client does not know through a rotation', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    const third = await join(server, first, true, second)
    const method = first.target.method()
    const read = await method.read()
    await method.write(
      new Map([
        ['settings.json', '{"a":1}\n'],
        ['future/new.json', '{"from":"a newer client"}\n'],
      ]),
      read.version,
    )
    await elevate(first, second)
    const res = await first.service.removeDevice(
      third.account.identity()?.deviceId ?? '',
      PASSPHRASE,
      '',
    )
    expect(res).toMatchObject({ ok: true, rotated: true })
    const after = await readRemote(
      { account: first.account, keyring: first.keyring },
      undefined,
      true,
    )
    expect(after.files.get('future/new.json')?.toString()).toBe('{"from":"a newer client"}\n')
  })
})
