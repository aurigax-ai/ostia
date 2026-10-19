import {
  PHONE_SCREENS_ASK_METHOD,
  PHONE_SCREENS_LISTEN_METHOD,
  PHONE_SCREENS_REQUEST_METHOD,
} from '@aurigax-ai/ostia-extension-sdk/contract/phoneScreens'
import { describe, expect, it, vi } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { setCaps } from '../approvals/capabilityStore'
import type { PaneIdentity } from '../control/idRegistry'
import type { ScreenLinkController } from '../gateway/screenLinks'
import { ExtensionPhoneScreens, type PhoneScreenLinks } from './extensionPhoneScreens'
import type { Runtime } from './extensionRuntime'

const registered = vi.hoisted(() => new Map<string, { callers?: string; cap?: string }>())

vi.mock('../control/controlServer', () => ({
  registerControlMethod: (name: string, spec: { callers?: string; cap?: string }) =>
    registered.set(name, spec),
}))

function fakeConn() {
  const closers: Array<() => void> = []
  const conn = {
    sendRequest: vi.fn().mockResolvedValue({ accept: true }),
    sendNotification: vi.fn().mockResolvedValue(undefined),
    onClose: (fn: () => void) => closers.push(fn),
    onDispose: (fn: () => void) => closers.push(fn),
  } as unknown as MessageConnection
  return {
    conn,
    close: () => {
      for (const fn of closers) fn()
    },
  }
}

function extension(id: string, caps: string[]) {
  const identity = { externalId: `ext-${id}`, extId: id, kind: 'extension' } as PaneIdentity
  const { conn, close } = fakeConn()
  const rt = { identity, conn, ext: { manifest: { id } } } as unknown as Runtime
  setCaps(identity.externalId, caps as never)
  return { identity, conn, close, rt }
}

function setup() {
  let holder: ScreenLinkController | null = null
  const links: PhoneScreenLinks = {
    listen: vi.fn((c: ScreenLinkController) => {
      if (holder && holder !== c) return false
      holder = c
      return true
    }),
    release: vi.fn((c: ScreenLinkController) => {
      if (holder === c) holder = null
    }),
    request: vi.fn().mockResolvedValue({ ok: true, data: { done: true } }),
    ask: vi.fn().mockResolvedValue({ ok: true, data: null }),
  }
  const runtimes = new Map<MessageConnection, Runtime>()
  let active = true
  const screens = new ExtensionPhoneScreens({
    links,
    runtimeOf: (_identity, conn) => {
      const rt = runtimes.get(conn)
      if (!rt) throw new Error('stale extension')
      return rt
    },
    active: () => active,
  })
  const add = (id: string, caps: string[]) => {
    const ext = extension(id, caps)
    runtimes.set(ext.conn, ext.rt)
    return ext
  }
  const disable = (): void => {
    active = false
  }
  return { screens, links, add, disable }
}

describe('ExtensionPhoneScreens', () => {
  it('PHD-C6 lets one extension listen and refuses another its requests', async () => {
    const { screens, links, add } = setup()
    const first = add('bridge', ['phone-screens'])
    const second = add('other', ['phone-screens'])
    expect(screens.listen(first.identity, first.conn)).toEqual({ ok: true, data: null })
    expect(screens.listen(second.identity, second.conn)).toEqual({ ok: false, error: 'busy' })

    const params = { linkId: 'l1', method: 'phone.tap', params: { x: 1, y: 2 } }
    expect(await screens.request(second.identity, second.conn, params)).toEqual({
      ok: false,
      error: 'not-listening',
    })
    expect(await screens.ask(second.identity, second.conn, { sessionId: 's1' })).toEqual({
      ok: false,
      error: 'not-listening',
    })
    expect(links.request).not.toHaveBeenCalled()
    expect(await screens.request(first.identity, first.conn, params)).toEqual({
      ok: true,
      data: { done: true },
    })
  })

  it('offers a link to the listener over its connection and reads its answer', async () => {
    const { screens, links, add } = setup()
    const ext = add('bridge', ['phone-screens'])
    screens.listen(ext.identity, ext.conn)
    const controller = vi.mocked(links.listen).mock.calls[0][0]
    const link = { linkId: 'l1' } as never
    expect(await controller.offer(link)).toBe(true)
    expect(ext.conn.sendRequest).toHaveBeenCalledWith('ext.phoneScreen.offer', link)
    vi.mocked(ext.conn.sendRequest).mockResolvedValueOnce({ accept: 'yes' })
    expect(await controller.offer(link)).toBe(false)
    controller.frame('l1', { seq: 1 } as never, Buffer.from([0xff, 0xd8]))
    expect(ext.conn.sendNotification).toHaveBeenCalledWith('ext.phoneScreen.frame', {
      linkId: 'l1',
      header: { seq: 1 },
      jpeg: '/9g=',
    })
  })

  it('PHD-C9 releases the links when the listener stops, is disabled or loses phone-screens', () => {
    for (const end of ['stops', 'disabled', 'loses'] as const) {
      const { screens, links, add, disable } = setup()
      const ext = add('bridge', ['phone-screens'])
      screens.listen(ext.identity, ext.conn)
      if (end === 'stops') ext.close()
      if (end === 'disabled') disable()
      if (end === 'loses') setCaps(ext.identity.externalId, [])
      screens.recheck()
      expect(links.release).toHaveBeenCalledTimes(1)
    }
  })

  it('PHD-C12 opens the phone screen methods to extensions holding phone-screens only', async () => {
    const { registerExtensionMethods } = await import('./extensionMethods')
    registerExtensionMethods(() => null)
    const phoneMethods = [...registered.keys()].filter((name) => /phone/i.test(name))
    expect(phoneMethods.sort()).toEqual(
      [PHONE_SCREENS_ASK_METHOD, PHONE_SCREENS_LISTEN_METHOD, PHONE_SCREENS_REQUEST_METHOD].sort(),
    )
    for (const name of phoneMethods) {
      expect(registered.get(name)).toMatchObject({ callers: 'extensions', cap: 'phone-screens' })
    }
  })
})
