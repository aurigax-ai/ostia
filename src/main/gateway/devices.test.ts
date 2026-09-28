import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PHONE_CAPS, list, registerDevice, revoke, verifyToken } from './devices'

function unsetEnv(key: string): void {
  delete process.env[key]
}

describe('gateway/devices', () => {
  let dir: string
  let prevXdg: string | undefined

  beforeEach(() => {
    dir = join(tmpdir(), `pine-gateway-devices-test-${process.pid}-${Date.now()}-${Math.random()}`)
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
})
