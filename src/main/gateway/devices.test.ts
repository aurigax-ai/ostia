import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storePath } from '../platform/jsonStore'
import {
  DEFAULT_PHONE_CAPS,
  get,
  list,
  registerDevice,
  revoke,
  setDeviceCap,
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
})
