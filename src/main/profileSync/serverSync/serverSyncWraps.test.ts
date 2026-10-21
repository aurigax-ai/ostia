import { type KeyObject, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { FakeServer } from '../../../../test/fixtures/server/fakeServer'
import { elevate, PASSPHRASE, type SyncDevice } from '../../../../test/fixtures/server/syncHarness'
import { syncWorld } from '../../../../test/fixtures/server/syncWorld'
import { generateDeviceKeys } from '../../server/deviceKeys'
import { newProfileKey, sealManifest, type WrapSigner, wrapForDevice } from './syncCrypto'
import { localPublicKeys } from './syncLink'
import { registerInManifest } from './syncRegister'
import { readRemote } from './syncRemote'

const { world, join, close } = syncWorld()

afterEach(close)

const DAY = 24 * 3_600_000
const signKey = (device: SyncDevice): KeyObject => {
  const keys = device.account.deviceKeys()
  if (!keys) throw new Error('no keys')
  return keys.signPrivate
}
const idOf = (device: SyncDevice): string => device.account.identity()?.deviceId ?? ''

function plant(
  server: FakeServer,
  victim: SyncDevice,
  attacker: Buffer,
  blob: Buffer,
  counter: number,
) {
  const data = server.syncData.get(server.devices.get(idOf(victim))?.accountId ?? '')
  if (!data) throw new Error('no account')
  data.wraps.set(`device:${idOf(victim)}`, { blob: blob.toString('base64url'), updatedAt: 0 })
  const sealed = sealManifest(attacker, { counter, files: {}, devices: [] })
  data.manifests.push({
    version: (data.manifests.at(-1)?.version ?? 0) + 1,
    blob: sealed.toString('base64url'),
    updatedAt: 0,
  })
}

async function rig() {
  const { server, first } = await world()
  const second = await join(server, first)
  server.advance(DAY + 3_600_000)
  const third = await join(server, first, true, second)
  await second.sync.run()
  const attacker = newProfileKey()
  const boxPub = Buffer.from(server.devices.get(idOf(second))?.boxPub ?? '', 'base64url')
  const victimKey = second.keyring.key() ?? Buffer.alloc(0)
  const highest = second.keyring.highest()
  const ahead = highest + 100
  const forge = (signer: WrapSigner, counter: number) =>
    wrapForDevice(attacker, boxPub, `device:${idOf(second)}`, signer, counter)
  return { server, first, second, third, attacker, victimKey, highest, ahead, forge }
}

describe('a linked device adopts a new key only from a trusted signed wrap', () => {
  const cases: Array<
    [string, 'untrusted' | 'too-new', (r: Awaited<ReturnType<typeof rig>>) => Buffer]
  > = [
    ['unsigned', 'untrusted', () => Buffer.concat([Buffer.from([1]), randomBytes(48)])],
    [
      'wrongly signed',
      'untrusted',
      (r) => r.forge({ id: idOf(r.first), signPrivate: generateDeviceKeys().signPrivate }, r.ahead),
    ],
    [
      'signed by a device the manifest does not list',
      'untrusted',
      (r) => r.forge({ id: 'ghost', signPrivate: generateDeviceKeys().signPrivate }, r.ahead),
    ],
    [
      'naming one trusted signer but signed with another one key',
      'untrusted',
      (r) => r.forge({ id: idOf(r.third), signPrivate: signKey(r.first) }, r.ahead),
    ],
    [
      'signed by a device younger than the age bound',
      'too-new',
      (r) => r.forge({ id: idOf(r.third), signPrivate: signKey(r.third) }, r.ahead),
    ],
    [
      'replaying a counter that is not above the highest',
      'untrusted',
      (r) => r.forge({ id: idOf(r.first), signPrivate: signKey(r.first) }, r.highest),
    ],
  ]

  for (const [index, [name, reason, build]] of cases.entries()) {
    it(`SSY-C${140 + index} ignores a wrap that is ${name}, keeps its key, uploads nothing and warns`, async () => {
      const r = await rig()
      plant(r.server, r.second, r.attacker, build(r), r.ahead)
      const uploads = r.server.requests.length
      const run = await r.second.sync.run()
      expect(run.status.state).toBe('error')
      expect(r.second.keyring.key()?.equals(r.victimKey)).toBe(true)
      expect(r.second.keyring.highest()).toBe(r.highest)
      expect(r.server.requests.slice(uploads).some((q) => q.startsWith('PUT'))).toBe(false)
      expect((await r.second.service.status()).wrapRefused).toMatchObject({ reason })
    })
  }

  it('SSY-C146 adopts a rotation signed by an old enough device of the manifest at a higher counter', async () => {
    const r = await rig()
    const signer = {
      id: idOf(r.first),
      signPrivate: signKey(r.first),
    }
    plant(r.server, r.second, r.attacker, r.forge(signer, r.ahead), r.ahead)
    expect((await r.second.sync.run()).status.state).toBe('ok')
    expect(r.second.keyring.key()?.equals(r.attacker)).toBe(true)
    expect((await r.second.service.status()).wrapRefused).toBeNull()
  })
})

describe('the age of a signer counts from when this client first saw it', () => {
  it('SSY-C156 refuses a backdated manifest entry written by a key holder until the first-seen age has passed', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    const third = await join(server, first, false, second)
    const keys = third.account.deviceKeys()
    if (!keys) throw new Error('no keys')
    const entry = { id: idOf(third), name: 'Backdated', ...localPublicKeys(keys), createdAt: 1 }
    const counter = await registerInManifest(
      { account: first.account, keyring: first.keyring },
      entry,
    )
    expect(counter).not.toBeNull()
    await second.sync.run()
    const attacker = newProfileKey()
    const boxPub = Buffer.from(server.devices.get(idOf(second))?.boxPub ?? '', 'base64url')
    const ahead = second.keyring.highest() + 100
    const wrap = wrapForDevice(
      attacker,
      boxPub,
      `device:${idOf(second)}`,
      { id: idOf(third), signPrivate: signKey(third) },
      ahead,
    )
    const kept = second.keyring.key()
    plant(server, second, attacker, wrap, ahead)
    expect((await second.sync.run()).status.state).toBe('error')
    expect(second.keyring.key()?.equals(kept ?? Buffer.alloc(0))).toBe(true)
    expect((await second.service.status()).wrapRefused).toMatchObject({ reason: 'too-new' })
    server.advance(DAY + 3_600_000)
    expect((await second.sync.run()).status.state).toBe('ok')
    expect(second.keyring.key()?.equals(attacker)).toBe(true)
  })

  it('SSY-C157 restarts the clock of a device whose keys or creation time change under the same id', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    server.advance(DAY + 3_600_000)
    await second.sync.run()
    const known = second.keyring.trusted().find((d) => d.id === idOf(first))
    if (!known) throw new Error('first is pinned')
    second.keyring.pin([{ ...known, createdAt: known.createdAt + 1 }])
    const attacker = newProfileKey()
    const boxPub = Buffer.from(server.devices.get(idOf(second))?.boxPub ?? '', 'base64url')
    const ahead = second.keyring.highest() + 100
    const wrap = wrapForDevice(
      attacker,
      boxPub,
      `device:${idOf(second)}`,
      { id: idOf(first), signPrivate: signKey(first) },
      ahead,
    )
    plant(server, second, attacker, wrap, ahead)
    expect((await second.sync.run()).status.state).toBe('error')
    expect((await second.service.status()).wrapRefused).toMatchObject({ reason: 'too-new' })
  })
})

describe('linking binds the key handover to what the human compared', () => {
  it('SSY-C147 refuses to wrap when the approve-time listing carries other keys than the shown code', async () => {
    const { server, first } = await world()
    const fresh = await join(server, first, false)
    await fresh.service.linkStart()
    const shown = (await first.service.status()).joins[0]
    expect(shown?.code).toBe((await fresh.service.status()).linkCodes[0]?.code)
    const freshId = idOf(fresh)
    const attacker = Buffer.alloc(32, 5).toString('base64url')
    server.rewriteDevices = (_viewer, rows) =>
      rows.map((r) => (r.id === freshId ? { ...r, boxPub: attacker } : r))
    const res = await first.service.approveJoin(freshId, shown?.code ?? '')
    expect(res).toMatchObject({ ok: false, error: 'untrusted' })
    const account = server.devices.get(idOf(first))?.accountId ?? ''
    expect(server.syncData.get(account)?.wraps.has(`device:${freshId}`)).toBe(false)
  })

  it('SSY-C148 refuses a code that does not belong to the device being approved', async () => {
    const { server, first } = await world()
    const a = await join(server, first, false)
    const b = await join(server, first, false, a)
    const joins = (await first.service.status()).joins
    const forA = joins.find((j) => j.deviceId === idOf(a))
    const forB = joins.find((j) => j.deviceId === idOf(b))
    expect(await first.service.approveJoin(idOf(a), forB?.code ?? '')).toMatchObject({
      ok: false,
      error: 'untrusted',
    })
    expect((await first.service.approveJoin(idOf(a), forA?.code ?? '')).ok).toBe(true)
  })

  it('SSY-C149 registers the joiner in the manifest only when the human approves', async () => {
    const { server, first } = await world()
    const fresh = await join(server, first, false)
    await fresh.service.linkStart()
    const manifestDevices = async () =>
      (await readRemote({ account: first.account, keyring: first.keyring })).manifest?.devices.map(
        (d) => d.id,
      )
    expect(await manifestDevices()).toEqual([idOf(first)])
    const join1 = (await first.service.status()).joins[0]
    await first.service.approveJoin(idOf(fresh), join1?.code ?? '')
    expect(await manifestDevices()).toEqual([idOf(first), idOf(fresh)])
  })

  it('SSY-C150 the joiner adopts only a wrap signed by the approver of the code it confirmed', async () => {
    const { server, first } = await world()
    const fresh = await join(server, first, false)
    await fresh.service.linkStart()
    const join1 = (await first.service.status()).joins[0]
    await first.service.approveJoin(idOf(fresh), join1?.code ?? '')
    const code = (await fresh.service.status()).linkCodes[0]?.code ?? ''
    const account = server.devices.get(idOf(first))?.accountId ?? ''
    const slot = `device:${idOf(fresh)}`
    const data = server.syncData.get(account)
    const honest = data?.wraps.get(slot)
    const boxPub = Buffer.from(server.devices.get(idOf(fresh))?.boxPub ?? '', 'base64url')
    const forged = wrapForDevice(
      newProfileKey(),
      boxPub,
      slot,
      { id: idOf(first), signPrivate: generateDeviceKeys().signPrivate },
      9,
    )
    data?.wraps.set(slot, { blob: forged.toString('base64url'), updatedAt: 0 })
    expect(await fresh.service.linkConfirm(code)).toMatchObject({ ok: false, error: 'no-wrap' })
    expect(fresh.keyring.key()).toBeNull()
    if (honest) data?.wraps.set(slot, honest)
    const swapped = Buffer.alloc(32, 3).toString('base64url')
    server.rewriteDevices = (viewer, rows) =>
      rows.map((r) =>
        r.id === idOf(first) && viewer === idOf(fresh) ? { ...r, signPub: swapped } : r,
      )
    expect(await fresh.service.linkConfirm(code)).toMatchObject({ ok: false, error: 'untrusted' })
    expect(fresh.keyring.key()).toBeNull()
    server.rewriteDevices = null
    expect((await fresh.service.linkConfirm(code)).ok).toBe(true)
    expect(fresh.keyring.key()?.equals(first.keyring.key() ?? Buffer.alloc(0))).toBe(true)
  })
})

describe('rotation wraps the new key only to the pinned keys', () => {
  it('SSY-C151 refuses to rotate when the server lists a second current device', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    server.rewriteDevices = (_viewer, rows) => [
      ...rows,
      {
        id: 'ghost1',
        name: 'Injected',
        signPub: 'a',
        boxPub: 'b',
        createdAt: 1,
        lastSeen: 0,
        current: true,
      },
    ]
    await elevate(first, second)
    const before = first.keyring.key()
    expect(await first.service.rotate(PASSPHRASE, '')).toMatchObject({
      ok: false,
      error: 'untrusted',
    })
    expect(first.keyring.key()?.equals(before ?? Buffer.alloc(0))).toBe(true)
  })

  it('SSY-C152 leaves out a listed device whose keys differ from the pinned ones', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    const account = server.devices.get(idOf(first))?.accountId ?? ''
    const slot = `device:${idOf(second)}`
    const before = server.syncData.get(account)?.wraps.get(slot)?.blob
    const swapped = Buffer.alloc(32, 8).toString('base64url')
    server.rewriteDevices = (_viewer, rows) =>
      rows.map((r) => (r.id === idOf(second) ? { ...r, boxPub: swapped } : r))
    await elevate(first, second)
    const res = await first.service.rotate(PASSPHRASE, '')
    expect(res).toMatchObject({ ok: true, rotated: true, unwrapped: ['Test desktop'] })
    expect(server.syncData.get(account)?.wraps.get(slot)?.blob).toBe(before)
  })

  it('SSY-C153 forgets an approved device once it is removed', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    const fresh = await join(server, first, false, second)
    await fresh.service.linkStart()
    const asked = (await first.service.status()).joins[0]
    await first.service.approveJoin(idOf(fresh), asked?.code ?? '')
    expect(first.keyring.trusted().map((d) => d.id)).toContain(idOf(fresh))
    await elevate(first, second)
    expect((await first.service.removeDevice(idOf(fresh), PASSPHRASE, '')).ok).toBe(true)
    expect(first.keyring.trusted().map((d) => d.id)).not.toContain(idOf(fresh))
  })

  it('SSY-C159 does not wrap the new key to a removed device the server keeps listing', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    const fresh = await join(server, first, false, second)
    await fresh.service.linkStart()
    const asked = (await first.service.status()).joins[0]
    await first.service.approveJoin(idOf(fresh), asked?.code ?? '')
    const listed = await first.account.authed((token, routes) => routes.devices(token))
    const revoked = listed.devices.filter((d) => d.id === idOf(fresh)).map((d) => ({ ...d }))
    expect(revoked).toHaveLength(1)
    server.rewriteDevices = (_viewer, rows) => [...rows, ...revoked]
    await elevate(first, second)
    const res = await first.service.removeDevice(idOf(fresh), PASSPHRASE, '')
    expect(res).toMatchObject({ ok: true, rotated: true, unwrapped: [] })
    const account = server.devices.get(idOf(first))?.accountId ?? ''
    const slots = [...(server.syncData.get(account)?.wraps.keys() ?? [])]
    expect(slots).not.toContain(`device:${idOf(fresh)}`)
    const remote = await readRemote({ account: first.account, keyring: first.keyring })
    expect(remote.manifest?.devices.map((d) => d.id).sort()).toEqual(
      [idOf(first), idOf(second)].sort(),
    )
    expect(first.keyring.trusted().map((d) => d.id)).not.toContain(idOf(fresh))
  })
})

describe('adoption trusts only the last opened manifest', () => {
  it('SSY-C160 refuses a wrap signed by a device another machine removed', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    const fresh = await join(server, first, false, second)
    await fresh.service.linkStart()
    const asked = (await first.service.status()).joins[0]
    await first.service.approveJoin(idOf(fresh), asked?.code ?? '')
    server.advance(2 * DAY)
    await second.sync.run()
    await elevate(second, first)
    expect((await second.service.removeDevice(idOf(fresh), PASSPHRASE, '')).ok).toBe(true)
    expect((await first.sync.run()).status.state).toBe('ok')
    expect(first.keyring.trusted().map((d) => d.id)).not.toContain(idOf(fresh))
    const adopted = first.keyring.key() ?? Buffer.alloc(0)
    const attacker = newProfileKey()
    const boxPub = Buffer.from(server.devices.get(idOf(first))?.boxPub ?? '', 'base64url')
    const ahead = first.keyring.highest() + 100
    const wrap = wrapForDevice(
      attacker,
      boxPub,
      `device:${idOf(first)}`,
      { id: idOf(fresh), signPrivate: signKey(fresh) },
      ahead,
    )
    plant(server, first, attacker, wrap, ahead)
    const uploads = server.requests.length
    expect((await first.sync.run()).status.state).toBe('error')
    expect(first.keyring.key()?.equals(adopted)).toBe(true)
    expect(server.requests.slice(uploads).some((q) => q.startsWith('PUT'))).toBe(false)
    expect((await first.service.status()).wrapRefused).toMatchObject({ reason: 'untrusted' })
  })
})

describe('what the human is told and can do after a refused rotation', () => {
  it('SSY-C161 tells a trusted but young signer apart, names the time and lets the passphrase unlock', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    const third = await join(server, first, true, second)
    await elevate(first, second)
    expect((await first.service.removeDevice(idOf(third), PASSPHRASE, '')).ok).toBe(true)
    expect((await second.sync.run()).status.state).toBe('error')
    const held = (await second.service.status()).wrapRefused
    expect(held?.reason).toBe('too-new')
    expect(held?.after).toBeGreaterThan(server.now())
    expect((await second.service.status()).state).toBe('ready')
    expect((await second.service.unlock(PASSPHRASE)).ok).toBe(true)
    expect((await second.service.status()).wrapRefused).toBeNull()
    expect((await second.sync.run()).status.state).toBe('ok')
    expect(second.keyring.key()?.equals(first.keyring.key() ?? Buffer.alloc(0))).toBe(true)
  })
})

describe('a join that another device overtakes', () => {
  it('SSY-C162 reports a stale link in its own words, keeps the device locked and stops waiting', async () => {
    const { server, first } = await world()
    const fresh = await join(server, first, false)
    await fresh.service.linkStart()
    const asked = (await first.service.status()).joins[0]
    await first.service.approveJoin(idOf(fresh), asked?.code ?? '')
    first.writeSettings({ locale: 'en' }, 1)
    await first.sync.run()
    const code = (await fresh.service.status()).linkCodes[0]?.code ?? ''
    const res = await fresh.service.linkConfirm(code)
    expect(res).toMatchObject({ ok: false, error: 'link-stale' })
    expect(fresh.keyring.key()).toBeNull()
    expect(res.status).toMatchObject({ state: 'locked', linking: false, linkApproved: false })
    expect((await fresh.service.unlock(PASSPHRASE)).ok).toBe(true)
  })
})

describe('a device whose keys or creation time change under the same id', () => {
  it('SSY-C163 is named in the status for a day after the change and then forgotten', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    expect((await second.service.status()).changedDevices).toEqual([])
    const known = second.keyring.trusted().find((d) => d.id === idOf(first))
    if (!known) throw new Error('first is pinned')
    second.keyring.pin([{ ...known, createdAt: known.createdAt + 1 }])
    expect((await second.service.status()).changedDevices).toEqual([known.name])
    server.advance(DAY + 3_600_000)
    expect((await second.service.status()).changedDevices).toEqual([])
  })

  it('SSY-C164 does not warn for a device that is seen for the first time or unchanged', async () => {
    const { server, first } = await world()
    const second = await join(server, first)
    await second.sync.run()
    await first.sync.run()
    expect((await first.service.status()).changedDevices).toEqual([])
    expect((await second.service.status()).changedDevices).toEqual([])
  })
})
