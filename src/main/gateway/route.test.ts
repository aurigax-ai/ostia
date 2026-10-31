import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FRIENDLY_NAME } from '../../shared/gateway/friendlyName'

vi.mock('electron', () => ({ app: { getPath: () => process.env.XDG_DATA_HOME } }))

const { checkRoute, friendlyName, loadRoute, saveRoute } = await import('./route')

let prevXdg: string | undefined
beforeAll(() => {
  prevXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'ostia-route-'))
})

afterAll(() => {
  const xdg = process.env.XDG_DATA_HOME
  if (prevXdg === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME')
  else process.env.XDG_DATA_HOME = prevXdg
  if (xdg) rmSync(xdg, { recursive: true, force: true })
})

const LAN = {
  bindAddress: '192.168.2.108',
  bindInterface: 'wlan0',
  tailnet: false,
  phoneAddress: null,
  relay: false,
}

const LOOPBACK = { ...LAN, bindAddress: '127.0.0.1', bindInterface: null }

describe('the saved route names the card of a local bind', () => {
  it('RDS-C25 accepts loopback with no card and a LAN address with its card', () => {
    expect(checkRoute(LAN)).toEqual(LAN)
    expect(checkRoute({ ...LAN, bindAddress: '127.0.0.1', bindInterface: null })).toMatchObject({
      bindInterface: null,
    })
  })

  it('RDS-C26 refuses a LAN address with no card and loopback with a card', () => {
    expect(checkRoute({ ...LAN, bindInterface: null })).toBe('unknown-address')
    expect(checkRoute({ ...LAN, bindAddress: '127.0.0.1' })).toBe('unknown-address')
    expect(checkRoute({ ...LAN, bindInterface: undefined })).toBe('unknown-address')
  })

  it('RLY-C43 keeps the relay switch and refuses a route without one', () => {
    expect(checkRoute({ ...LOOPBACK, relay: true })).toMatchObject({ relay: true })
    expect(checkRoute({ ...LAN, relay: undefined })).toBe('unknown-address')
    expect(checkRoute({ ...LAN, relay: 'yes' })).toBe('unknown-address')
  })

  it('RDS-C29 refuses a route with two connection methods on', () => {
    const phoneAddress = { host: 'desk.example.com', port: 443 }
    expect(checkRoute({ ...LOOPBACK, relay: true, tailnet: true })).toBe('two-methods')
    expect(checkRoute({ ...LAN, tailnet: true })).toBe('two-methods')
    expect(checkRoute({ ...LAN, relay: true })).toBe('two-methods')
    expect(checkRoute({ ...LOOPBACK, tailnet: true, phoneAddress })).toBe('two-methods')
    expect(checkRoute({ ...LOOPBACK, phoneAddress })).toMatchObject({ phoneAddress })
    expect(checkRoute({ ...LOOPBACK, tailnet: true })).toMatchObject({ tailnet: true })
    expect(checkRoute(LOOPBACK)).toEqual(LOOPBACK)
  })

  it('RDS-C27 reads a saved route back with its card', () => {
    saveRoute(LAN)
    expect(loadRoute()).toEqual(LAN)
  })
})

describe('the desktop’s friendly name', () => {
  it('RDS-C28 is two random words, made once and kept', () => {
    const first = friendlyName()
    expect(first).toMatch(FRIENDLY_NAME)
    expect(friendlyName()).toBe(first)
  })
})
