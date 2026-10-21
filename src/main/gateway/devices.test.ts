import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storePath } from '../platform/jsonStore'
import {
  DEFAULT_PHONE_CAPS,
  type Device,
  get,
  list,
  pushOf,
  registerDevice,
  revoke,
  setDeviceCap,
  setDeviceName,
  setDevicePush,
  verifyToken,
} from './devices'

function unsetEnv(key: string): void {
  delete process.env[key]
}

describe('gateway/devices', () => {
  let dir: string
  let prevXdg: string | undefined

  beforeEach(() => {
    dir = join(tmpdir(), `ostia-gateway-devices-test-${process.pid}-${Date.now()}-${Math.random()}`)
    prevXdg = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
  })

  afterEach(() => {
    if (prevXdg === undefined) unsetEnv('XDG_DATA_HOME')
    else process.env.XDG_DATA_HOME = prevXdg
    rmSync(dir, { recursive: true, force: true })
  })

  it('registerDevice mints a deviceId + opaque token and seeds default phone caps', () => {
    const res = registerDevice({ name: 'iPhone 15', pubkey: 'BASE64-SPKI' })
    expect(res.deviceId).toMatch(/^dev_/)
    expect(res.token).toMatch(/^[0-9a-f]{64}$/)
    expect(res.caps).toEqual([...DEFAULT_PHONE_CAPS])
  })

  it('registerDevice mints distinct deviceIds and tokens on repeated calls', () => {
    const a = registerDevice({ name: 'A', pubkey: 'pkA' })
    const b = registerDevice({ name: 'B', pubkey: 'pkB' })
    expect(a.deviceId).not.toBe(b.deviceId)
    expect(a.token).not.toBe(b.token)
  })

  it('verifyToken resolves a registered device by its bearer token', () => {
    const { deviceId, token } = registerDevice({ name: 'iPhone 15', pubkey: 'BASE64-SPKI' })
    const device = verifyToken(token)
    expect(device?.deviceId).toBe(deviceId)
    expect(device?.name).toBe('iPhone 15')
  })

  it('verifyToken returns null for an unknown token', () => {
    expect(verifyToken('not-a-real-token')).toBeNull()
  })

  it('list returns every registered device', () => {
    registerDevice({ name: 'A', pubkey: 'pkA' })
    registerDevice({ name: 'B', pubkey: 'pkB' })
    expect(
      list()
        .map((d) => d.name)
        .sort(),
    ).toEqual(['A', 'B'])
  })

  it('revoke deletes a device and its token stops verifying', () => {
    const { deviceId, token } = registerDevice({ name: 'iPhone 15', pubkey: 'BASE64-SPKI' })
    expect(revoke(deviceId)).toBe(true)
    expect(verifyToken(token)).toBeNull()
  })

  it('revoke returns false for an unknown deviceId', () => {
    expect(revoke('dev_does-not-exist')).toBe(false)
  })

  describe('setDeviceCap', () => {
    it('grants input and persists it so a later lookup sees the raised caps', () => {
      const { deviceId, token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      expect(setDeviceCap(deviceId, 'input', true)).toEqual({
        ok: true,
        caps: ['read', 'notify', 'input'],
      })
      expect(verifyToken(token)?.caps).toContain('input')
      expect(get(deviceId)?.caps).toContain('input')
    })

    it('keeps respond in the canonical order read, notify, respond, command, input, destructive', () => {
      const { deviceId } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      setDeviceCap(deviceId, 'input', true)
      setDeviceCap(deviceId, 'command', true)
      expect(setDeviceCap(deviceId, 'respond', true)).toEqual({
        ok: true,
        caps: ['read', 'notify', 'respond', 'command', 'input'],
      })
    })

    it('revokes a granted cap', () => {
      const { deviceId } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      setDeviceCap(deviceId, 'command', true)
      expect(setDeviceCap(deviceId, 'command', false)).toEqual({
        ok: true,
        caps: ['read', 'notify'],
      })
    })

    it('refuses to grant or strip a base cap or an unknown cap', () => {
      const { deviceId } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      for (const cap of ['read', 'notify', 'gateway', 'all-workspaces', 42]) {
        expect(setDeviceCap(deviceId, cap, false)).toEqual({ ok: false, error: 'invalid-cap' })
        expect(setDeviceCap(deviceId, cap, true)).toEqual({ ok: false, error: 'invalid-cap' })
      }
      expect(get(deviceId)?.caps).toEqual([...DEFAULT_PHONE_CAPS])
    })

    it('refuses destructive until command is granted', () => {
      const { deviceId } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      expect(setDeviceCap(deviceId, 'destructive', true)).toEqual({
        ok: false,
        error: 'requires-command',
      })
      setDeviceCap(deviceId, 'command', true)
      expect(setDeviceCap(deviceId, 'destructive', true)).toEqual({
        ok: true,
        caps: ['read', 'notify', 'command', 'destructive'],
      })
    })

    it('drops destructive when command is revoked', () => {
      const { deviceId } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      setDeviceCap(deviceId, 'command', true)
      setDeviceCap(deviceId, 'destructive', true)
      setDeviceCap(deviceId, 'command', false)
      expect(get(deviceId)?.caps).toEqual(['read', 'notify'])
    })

    it('drops caps a stored device holds that ostia no longer knows', () => {
      const { deviceId, token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      const file = storePath('gateway-devices', 'global')
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      stored[deviceId].caps = ['read', 'board.read', 'notify', 'board.write', 'input']
      writeFileSync(file, JSON.stringify(stored))
      expect(get(deviceId)?.caps).toEqual(['read', 'notify', 'input'])
      expect(verifyToken(token)?.caps).toEqual(['read', 'notify', 'input'])
    })

    it('is not-found for an unknown device', () => {
      expect(setDeviceCap('dev_nope', 'input', true)).toEqual({ ok: false, error: 'not-found' })
    })
  })

  it('PID-C7 updates a device name from the phone, trimmed, and keeps the old one for a bad name', () => {
    const { deviceId } = registerDevice({ name: 'Pixel', pubkey: 'pk' })
    expect(setDeviceName(deviceId, '  Desk phone  ')).toBe(true)
    expect(get(deviceId)?.name).toBe('Desk phone')
    for (const bad of [
      '   ',
      7,
      'a\nb',
      'a\u202Eb',
      'a\u200Bb',
      'a\u2028b',
      'a\u0000b',
      'a\ud800b',
    ]) {
      expect(setDeviceName(deviceId, bad)).toBe(false)
    }
    expect(setDeviceName('dev_missing', 'x')).toBe(false)
    expect(get(deviceId)?.name).toBe('Desk phone')
  })

  it('PID-C8 cuts a long name at 64 characters without splitting an emoji', () => {
    const { deviceId } = registerDevice({ name: 'a'.repeat(200), pubkey: 'pk' })
    expect(get(deviceId)?.name).toHaveLength(64)
    const emoji = registerDevice({ name: '\u{1F600}'.repeat(70), pubkey: 'pk' })
    expect(Array.from(get(emoji.deviceId)?.name ?? '')).toHaveLength(64)
    expect(() => encodeURIComponent(get(emoji.deviceId)?.name ?? '')).not.toThrow()
  })

  it('PID-C9 replaces every row of one install identity and revokes their tokens', () => {
    const old = registerDevice({ name: 'Pixel', pubkey: 'pk1', installId: 'i'.repeat(20) })
    setDeviceCap(old.deviceId, 'input', true)
    const next = registerDevice({ name: 'Pixel', pubkey: 'pk2', installId: 'i'.repeat(20) })
    expect(get(next.deviceId)?.caps).toEqual(['read', 'notify', 'input'])
    expect(next.replaced).toEqual([old.deviceId])
    expect(list().map((d) => d.deviceId)).toEqual([next.deviceId])
    expect(verifyToken(old.token)).toBeNull()
  })

  it('PSH-C50 keeps push off by default and stores the switch, handle and platform in the secure store', () => {
    const { deviceId } = registerDevice({ name: 'Pixel', pubkey: 'pk' })
    expect(pushOf(get(deviceId) as Device)).toEqual({ enabled: false })
    const handle = 'h'.repeat(26)
    expect(setDevicePush(deviceId, { enabled: true, handle, platform: 'fcm' })).toBe(true)
    expect(get(deviceId)?.push).toEqual({ enabled: true, handle, platform: 'fcm' })
    expect(setDevicePush('dev_missing', { enabled: true })).toBe(false)
  })

  it('PSH-C51 drops the handle when the switch goes off and refuses a malformed handle or platform', () => {
    const { deviceId } = registerDevice({ name: 'Pixel', pubkey: 'pk' })
    setDevicePush(deviceId, { enabled: true, handle: 'h'.repeat(26), platform: 'apns' })
    setDevicePush(deviceId, { enabled: false })
    expect(pushOf(get(deviceId) as Device)).toEqual({ enabled: false })
    setDevicePush(deviceId, { enabled: true, handle: 'bad handle!', platform: 'fcm' })
    expect(pushOf(get(deviceId) as Device)).toEqual({ enabled: true })
    setDevicePush(deviceId, { enabled: true, handle: 'h'.repeat(26), platform: 'sms' as never })
    expect(pushOf(get(deviceId) as Device)).toEqual({ enabled: true })
  })

  it('PSH-C52 does not carry the switch or the handle over to the device an approval replaces', () => {
    const installId = 'p'.repeat(20)
    const old = registerDevice({ name: 'Pixel', pubkey: 'pk1', installId })
    const handle = 'h'.repeat(26)
    setDevicePush(old.deviceId, { enabled: true, handle, platform: 'fcm' })
    const next = registerDevice({ name: 'Pixel', pubkey: 'pk2', installId })
    expect(next.replacedHandles).toEqual([handle])
    expect(pushOf(get(next.deviceId) as Device)).toEqual({ enabled: false })
  })
})
