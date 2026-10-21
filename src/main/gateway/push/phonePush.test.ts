import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AccountHarness,
  accountHarness,
  signedIn,
} from '../../../../test/fixtures/server/accountHarness'
import type { Device, DevicePush } from '../devices'
import { PhonePush, type PushConfig } from './phonePush'

const HOUR_S = 3600
const SECOND_MS = 1000
const TOKEN = 'fcm-registration-token'

interface Rig {
  harness: AccountHarness
  push: PhonePush
  devices: Map<string, Device>
  connected: Set<string>
  needs: { value: boolean }
  sent: Array<[string, PushConfig]>
  changed: ReturnType<typeof vi.fn>
  advance: (ms: number) => void
  add: (caps?: string[]) => string
  serverPings: () => number
}

let rig: Rig
let next = 1

async function build(harness: AccountHarness, options: { start?: boolean } = {}): Promise<Rig> {
  const devices = new Map<string, Device>()
  const connected = new Set<string>()
  const needs = { value: true }
  const sent: Array<[string, PushConfig]> = []
  const changed = vi.fn()
  let clock = 5_000_000
  const push = new PhonePush({
    account: harness.account,
    devices: {
      list: () => [...devices.values()],
      get: (id) => devices.get(id) ?? null,
      setPush: (id, value: DevicePush) => {
        const device = devices.get(id)
        if (!device) return false
        device.push = value.enabled ? value : undefined
        return true
      },
    },
    connected: (id) => connected.has(id),
    needsHuman: async () => needs.value,
    sendConfig: (id, config) => sent.push([id, config]),
    changed,
    now: () => clock,
  })
  if (options.start !== false) {
    push.start()
    await push.refreshOffer()
  }
  return {
    harness,
    push,
    devices,
    connected,
    needs,
    sent,
    changed,
    advance: (ms) => {
      clock += ms
      harness.server.advance(ms)
    },
    add: (caps = ['read', 'notify']) => {
      const deviceId = `dev_${next++}`
      devices.set(deviceId, {
        deviceId,
        name: 'Pixel',
        pubkey: 'pk',
        token: 'tok',
        caps,
        createdAt: '2026-10-21T00:00:00.000Z',
      })
      return deviceId
    },
    serverPings: () => harness.server.push.pings.length,
  }
}

async function phoneRegisters(deviceId: string, token = TOKEN): Promise<string> {
  const minted = await rig.push.ticket(deviceId)
  if (!minted.ok) throw new Error(`no ticket: ${minted.error}`)
  const res = await fetch(`${rig.harness.server.url}/v1/push/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'fcm', token, ticket: minted.ticket }),
  })
  const { handle } = (await res.json()) as { handle: string }
  expect(rig.push.register(deviceId, handle, 'fcm')).toEqual({ ok: true })
  return handle
}

async function registeredDevice(caps?: string[]): Promise<{ deviceId: string; handle: string }> {
  const deviceId = rig.add(caps)
  expect(await rig.push.setEnabled(deviceId, true)).toEqual({ ok: true })
  return { deviceId, handle: await phoneRegisters(deviceId) }
}

const server = (): string => rig.harness.server.url

beforeEach(async () => {
  rig = await build(await signedIn({ push: true, sessionTtlMs: 48 * HOUR_S * SECOND_MS }))
})

afterEach(async () => {
  rig.push.stop()
  await rig.harness.close()
})

describe('push through the server: the switch and hello', () => {
  it('PSH-C1 omits push from hello while the switch is off and carries server and registered once on', async () => {
    const deviceId = rig.add()
    const device = rig.devices.get(deviceId) as Device
    expect(rig.push.hello(device)).toBeUndefined()
    expect(await rig.push.setEnabled(deviceId, true)).toEqual({ ok: true })
    expect(rig.push.hello(device)).toEqual({ server: server(), registered: false })
    await phoneRegisters(deviceId)
    expect(rig.push.hello(device)).toEqual({ server: server(), registered: true })
  })

  it('PSH-C2 disables the switch with the reason when the server offers no push', async () => {
    await rig.harness.close()
    rig = await build(await signedIn({ push: false }))
    const deviceId = rig.add()
    expect(await rig.push.setEnabled(deviceId, true)).toEqual({
      ok: false,
      error: 'server-push-off',
    })
    expect(rig.push.availability()).toBe('server-push-off')
    expect(rig.devices.get(deviceId)?.push).toBeUndefined()
  })

  it('PSH-C3 refuses the switch when not signed in to a server', async () => {
    await rig.harness.close()
    rig = await build(await accountHarness({ push: true }))
    const deviceId = rig.add()
    expect(await rig.push.setEnabled(deviceId, true)).toEqual({
      ok: false,
      error: 'not-signed-in',
    })
    expect(rig.push.availability()).toBe('not-signed-in')
  })

  it('PSH-C4 refuses the switch for a device without notify, and for an unknown device', async () => {
    const deviceId = rig.add(['read'])
    expect(await rig.push.setEnabled(deviceId, true)).toEqual({ ok: false, error: 'needs-notify' })
    expect(await rig.push.setEnabled('dev_none', true)).toEqual({ ok: false, error: 'not-found' })
  })

  it('PSH-C5 sends push.config with the server and registered false when the switch goes on', async () => {
    const deviceId = rig.add()
    await rig.push.setEnabled(deviceId, true)
    expect(rig.sent).toEqual([[deviceId, { server: server(), registered: false }]])
    expect(rig.changed).toHaveBeenCalled()
  })

  it('PSH-C6 sends push.config null and deletes the handle at the server when the switch goes off', async () => {
    const { deviceId, handle } = await registeredDevice()
    rig.sent.length = 0
    expect(await rig.push.setEnabled(deviceId, false)).toEqual({ ok: true })
    expect(rig.sent).toEqual([[deviceId, { server: null }]])
    await vi.waitFor(() => expect(rig.harness.server.push.deleted).toEqual([handle]))
    expect(rig.devices.get(deviceId)?.push).toBeUndefined()
  })

  it('PSH-C7 reports registered false after the switch went off and on', async () => {
    const { deviceId } = await registeredDevice()
    await rig.push.setEnabled(deviceId, false)
    await rig.push.setEnabled(deviceId, true)
    expect(rig.push.hello(rig.devices.get(deviceId) as Device)).toEqual({
      server: server(),
      registered: false,
    })
  })

  it('PSH-C8 leaves hello without push and announces null when the account signs out', async () => {
    const { deviceId } = await registeredDevice()
    rig.sent.length = 0
    await rig.harness.account.signOut()
    expect(rig.sent).toEqual([[deviceId, { server: null }]])
    const device = rig.devices.get(deviceId) as Device
    expect(rig.push.hello(device)).toBeUndefined()
    expect(device.push).toEqual({ enabled: true })
  })
})

describe('push through the server: push.ticket, push.register, push.unregister', () => {
  it('PSH-C9 answers push-off to a ticket while the switch is off', async () => {
    const deviceId = rig.add()
    expect(await rig.push.ticket(deviceId)).toEqual({ ok: false, error: 'push-off' })
  })

  it('PSH-C10 gets a single-use ticket from the server that the phone registers with', async () => {
    const deviceId = rig.add()
    await rig.push.setEnabled(deviceId, true)
    const minted = await rig.push.ticket(deviceId)
    expect(minted.ok).toBe(true)
    expect(rig.harness.server.push.tickets.size).toBe(1)
    const handle = await phoneRegisters(deviceId)
    expect(rig.harness.server.push.handles.get(handle)?.token).toBe(TOKEN)
  })

  it('PSH-C11 answers rate-limited when asked too often, and when the server says so', async () => {
    const deviceId = rig.add()
    await rig.push.setEnabled(deviceId, true)
    for (let i = 0; i < 3; i += 1) expect((await rig.push.ticket(deviceId)).ok).toBe(true)
    expect(await rig.push.ticket(deviceId)).toEqual({ ok: false, error: 'rate-limited' })
    rig.advance(11 * 60 * SECOND_MS)
    rig.harness.server.intercept('POST /v1/push/tickets', {
      status: 429,
      body: { error: 'rate-limited' },
      headers: { 'Retry-After': '600' },
    })
    expect(await rig.push.ticket(deviceId)).toEqual({ ok: false, error: 'rate-limited' })
  })

  it('PSH-C12 answers server-unavailable when the server cannot mint a ticket', async () => {
    const deviceId = rig.add()
    await rig.push.setEnabled(deviceId, true)
    rig.harness.server.intercept('POST /v1/push/tickets', { status: 503, body: { error: 'busy' } })
    expect(await rig.push.ticket(deviceId)).toEqual({ ok: false, error: 'server-unavailable' })
  })

  it('PSH-C13 stores the handle on the device record and refuses a malformed handle or platform', async () => {
    const deviceId = rig.add()
    await rig.push.setEnabled(deviceId, true)
    expect(rig.push.register(deviceId, 'short', 'fcm')).toEqual({ ok: false, error: 'bad-params' })
    expect(rig.push.register(deviceId, 'a'.repeat(30), 'sms')).toEqual({
      ok: false,
      error: 'bad-params',
    })
    expect(rig.push.register(deviceId, 'a'.repeat(30), 'apns')).toEqual({ ok: true })
    expect(rig.devices.get(deviceId)?.push).toEqual({
      enabled: true,
      handle: 'a'.repeat(30),
      platform: 'apns',
    })
  })

  it('PSH-C14 answers push-off to a register while the switch is off', () => {
    const deviceId = rig.add()
    expect(rig.push.register(deviceId, 'a'.repeat(30), 'fcm')).toEqual({
      ok: false,
      error: 'push-off',
    })
  })

  it('PSH-C15 deletes the old handle at the server when the phone registers a new one', async () => {
    const { deviceId, handle } = await registeredDevice()
    const fresh = await phoneRegisters(deviceId, 'second-token')
    expect(fresh).not.toBe(handle)
    await vi.waitFor(() => expect(rig.harness.server.push.deleted).toEqual([handle]))
  })

  it('PSH-C16 forgets the handle and calls DELETE on unregister, and tolerates a second one', async () => {
    const { deviceId, handle } = await registeredDevice()
    expect(rig.push.unregister(deviceId)).toEqual({ ok: true })
    await vi.waitFor(() => expect(rig.harness.server.push.deleted).toEqual([handle]))
    expect(rig.devices.get(deviceId)?.push).toEqual({ enabled: true })
    expect(rig.push.unregister(deviceId)).toEqual({ ok: true })
    expect(rig.push.unregister('dev_gone')).toEqual({ ok: true })
  })

  it('PSH-C17 tolerates an unregister for a handle the server no longer has', async () => {
    const { deviceId, handle } = await registeredDevice()
    rig.harness.server.push.handles.delete(handle)
    expect(rig.push.unregister(deviceId)).toEqual({ ok: true })
    await vi.waitFor(() =>
      expect(rig.harness.server.requests).toContain(`DELETE /v1/push/${handle}`),
    )
  })

  it('PSH-C18 deletes the handle at the server when the device is revoked', async () => {
    const { handle } = await registeredDevice()
    rig.push.deviceRemoved(handle)
    await vi.waitFor(() => expect(rig.harness.server.push.deleted).toEqual([handle]))
  })
})

describe('push through the server: the ping', () => {
  it('PSH-C19 pings a device with no live socket on needs-input, ask and notify, with no body and no content type', async () => {
    const { handle } = await registeredDevice()
    await rig.push.event('agent.needs-input')
    expect(rig.harness.server.push.pings).toMatchObject([
      { handle, platform: 'fcm', token: TOKEN, contentType: undefined },
    ])
    rig.advance(31 * SECOND_MS)
    await rig.push.event('ask.created')
    rig.advance(31 * SECOND_MS)
    await rig.push.event('notify')
    expect(rig.serverPings()).toBe(3)
  })

  it('PSH-C20 never pings for done, failed or state events', async () => {
    await registeredDevice()
    for (const type of [
      'agent.done',
      'session.state',
      'pane.state',
      'ask.resolved',
      'artifact.changed',
    ]) {
      await rig.push.event(type)
      rig.advance(31 * SECOND_MS)
    }
    expect(rig.serverPings()).toBe(0)
    expect(
      rig.harness.server.requests.some((r) => /^POST \/v1\/push\/[a-z2-7]{20,}$/.test(r)),
    ).toBe(false)
  })

  it('PSH-C21 never pings a device with a live socket', async () => {
    const { deviceId } = await registeredDevice()
    rig.connected.add(deviceId)
    await rig.push.event('notify')
    expect(rig.serverPings()).toBe(0)
    rig.connected.delete(deviceId)
    await rig.push.event('notify')
    expect(rig.serverPings()).toBe(1)
  })

  it('PSH-C22 pings only a device holding notify, with the switch on and a handle', async () => {
    const { deviceId } = await registeredDevice()
    const device = rig.devices.get(deviceId) as Device
    device.caps = ['read']
    await rig.push.event('notify')
    device.caps = ['read', 'notify']
    await rig.push.setEnabled(rig.add(), true)
    rig.add()
    await rig.push.event('notify')
    expect(rig.serverPings()).toBe(1)
    await rig.push.setEnabled(deviceId, false)
    rig.advance(31 * SECOND_MS)
    await rig.push.event('notify')
    expect(rig.serverPings()).toBe(1)
  })

  it('PSH-C23 sends at most one ping per 30 seconds per handle', async () => {
    await registeredDevice()
    await rig.push.event('notify')
    rig.advance(10 * SECOND_MS)
    await rig.push.event('agent.needs-input')
    expect(rig.serverPings()).toBe(1)
    rig.advance(21 * SECOND_MS)
    await rig.push.event('agent.needs-input')
    expect(rig.serverPings()).toBe(2)
  })

  it('PSH-C24 sends at most 60 pings an hour per handle', async () => {
    await registeredDevice()
    for (let i = 0; i < 70; i += 1) {
      await rig.push.event('notify')
      rig.advance(31 * SECOND_MS)
    }
    expect(rig.serverPings()).toBe(60)
    rig.advance(HOUR_S * SECOND_MS)
    await rig.push.event('notify')
    expect(rig.serverPings()).toBe(61)
  })

  it('PSH-C25 backs off by Retry-After on a 429 and sends nothing in between', async () => {
    const { handle } = await registeredDevice()
    rig.harness.server.intercept(`POST /v1/push/${handle}`, {
      status: 429,
      body: { error: 'rate-limited' },
      headers: { 'Retry-After': '120' },
    })
    await rig.push.event('notify')
    const posts = (): number =>
      rig.harness.server.requests.filter((r) => r === `POST /v1/push/${handle}`).length
    expect(posts()).toBe(1)
    rig.advance(60 * SECOND_MS)
    await rig.push.event('notify')
    expect(posts()).toBe(1)
    rig.advance(61 * SECOND_MS)
    await rig.push.event('notify')
    expect(posts()).toBe(2)
    expect(rig.serverPings()).toBe(1)
  })

  it('PSH-C26 drops the handle on a 410, reports registered false and tells a connected phone', async () => {
    const { deviceId, handle } = await registeredDevice()
    rig.harness.server.push.handles.delete(handle)
    rig.sent.length = 0
    rig.changed.mockClear()
    await rig.push.event('notify')
    expect(rig.devices.get(deviceId)?.push).toEqual({ enabled: true })
    expect(rig.sent).toEqual([[deviceId, { server: server(), registered: false }]])
    expect(rig.changed).toHaveBeenCalled()
    rig.advance(31 * SECOND_MS)
    await rig.push.event('notify')
    expect(rig.harness.server.requests.filter((r) => r === `POST /v1/push/${handle}`)).toHaveLength(
      1,
    )
  })

  it('PSH-C27 does not retry a failed ping, keeps the handle and never throws', async () => {
    const { deviceId, handle } = await registeredDevice()
    rig.harness.server.intercept(`POST /v1/push/${handle}`, {
      status: 502,
      body: { error: 'delivery-failed' },
    })
    await expect(rig.push.event('notify')).resolves.toBeUndefined()
    expect(rig.harness.server.requests.filter((r) => r === `POST /v1/push/${handle}`)).toHaveLength(
      1,
    )
    expect(rig.devices.get(deviceId)?.push?.handle).toBe(handle)
    rig.advance(31 * SECOND_MS)
    await rig.push.event('notify')
    expect(rig.serverPings()).toBe(1)
  })

  it('PSH-C28 does not ping once the account signed out', async () => {
    await registeredDevice()
    await rig.harness.account.signOut()
    await rig.push.event('notify')
    expect(rig.serverPings()).toBe(0)
  })
})

describe('push through the server: a phone that slept, sign-out and lost permission', () => {
  it('PSH-C63 pings once when the last socket goes after an event arrived while it was still registered', async () => {
    const { deviceId } = await registeredDevice()
    rig.connected.add(deviceId)
    await rig.push.event('agent.needs-input')
    expect(rig.serverPings()).toBe(0)
    rig.connected.delete(deviceId)
    await rig.push.deviceGone(deviceId)
    expect(rig.serverPings()).toBe(1)
    await rig.push.deviceGone(deviceId)
    expect(rig.serverPings()).toBe(1)
  })

  it('PSH-C64 pings nothing when the socket goes with nothing waiting for the human, or while a socket is live', async () => {
    const { deviceId } = await registeredDevice()
    rig.needs.value = false
    await rig.push.deviceGone(deviceId)
    expect(rig.serverPings()).toBe(0)
    rig.needs.value = true
    rig.connected.add(deviceId)
    await rig.push.deviceGone(deviceId)
    expect(rig.serverPings()).toBe(0)
  })

  it('PSH-C65 deletes every handle at the server on sign-out, before the session ends', async () => {
    const first = await registeredDevice()
    const second = await registeredDevice()
    await rig.harness.account.signOut()
    expect([...rig.harness.server.push.deleted].sort()).toEqual(
      [first.handle, second.handle].sort(),
    )
    expect(rig.harness.server.push.handles.size).toBe(0)
    for (const id of [first.deviceId, second.deviceId]) {
      expect(rig.devices.get(id)?.push).toEqual({ enabled: true })
    }
  })

  it('PSH-C66 clears the handles locally on sign-out even when the server refuses the delete', async () => {
    const { deviceId, handle } = await registeredDevice()
    rig.harness.server.intercept(`DELETE /v1/push/${handle}`, {
      status: 503,
      body: { error: 'busy' },
    })
    await rig.harness.account.signOut()
    expect(rig.devices.get(deviceId)?.push).toEqual({ enabled: true })
    expect(rig.harness.server.push.handles.has(handle)).toBe(true)
    expect(rig.harness.account.signedIn()).toBe(false)
  })

  it('PSH-C67 turns push off, deletes the handle and tells the phone when notify is removed', async () => {
    const { deviceId, handle } = await registeredDevice()
    const device = rig.devices.get(deviceId) as Device
    device.caps = ['read']
    rig.sent.length = 0
    rig.push.capsChanged(deviceId)
    expect(device.push).toBeUndefined()
    expect(rig.sent).toEqual([[deviceId, { server: null }]])
    await vi.waitFor(() => expect(rig.harness.server.push.deleted).toEqual([handle]))
    expect(rig.push.hello(device)).toBeUndefined()
  })

  it('PSH-C68 stops advertising push to a device without notify and leaves one that kept it alone', async () => {
    const { deviceId } = await registeredDevice()
    const device = rig.devices.get(deviceId) as Device
    rig.push.capsChanged(deviceId)
    expect(device.push?.enabled).toBe(true)
    device.caps = ['read']
    expect(rig.push.hello(device)).toBeUndefined()
  })
})
