import { describe, expect, it, vi } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { PhoneScreenLink } from '../contract/phoneScreens'
import { phoneScreenMethods } from './phoneScreens'

function fakeConn(reply: unknown = { ok: true, data: null }) {
  const handlers = new Map<string, (params: never) => unknown>()
  const conn = {
    onRequest: (method: string, fn: (params: never) => unknown) => handlers.set(method, fn),
    onNotification: (method: string, fn: (params: never) => unknown) => handlers.set(method, fn),
    sendRequest: vi.fn().mockResolvedValue(reply),
  } as unknown as MessageConnection
  const deliver = (method: string, params: unknown) => handlers.get(method)?.(params as never)
  return { conn, deliver, handlers }
}

describe('phoneScreens', () => {
  it('answers an offer with the controller and hands it frames and events', async () => {
    const { conn, deliver } = fakeConn()
    const screens = phoneScreenMethods(conn)
    const frames: unknown[] = []
    const events: unknown[] = []
    expect(
      await screens.listen({
        offer: (link) => link.sessionId === 's1',
        frame: (frame) => frames.push(frame),
        event: (event) => events.push(event),
      }),
    ).toEqual({ ok: true, data: null })
    expect(conn.sendRequest).toHaveBeenCalledWith('ext.phoneScreens.listen', {})

    const link = { linkId: 'l1', sessionId: 's1' } as PhoneScreenLink
    expect(await deliver('ext.phoneScreen.offer', link)).toEqual({ accept: true })
    expect(await deliver('ext.phoneScreen.offer', { ...link, sessionId: 's2' })).toEqual({
      accept: false,
    })
    deliver('ext.phoneScreen.frame', { linkId: 'l1', header: { seq: 3 }, jpeg: '/9g=' })
    deliver('ext.phoneScreen.event', { linkId: 'l1', kind: 'ended', payload: { reason: 'closed' } })
    expect(frames).toEqual([{ linkId: 'l1', header: { seq: 3 }, jpeg: Buffer.from([0xff, 0xd8]) }])
    expect(events).toEqual([{ linkId: 'l1', kind: 'ended', payload: { reason: 'closed' } }])
  })

  it('refuses an offer when the controller throws and turns a refused call into a failure', async () => {
    const { conn, deliver } = fakeConn()
    const screens = phoneScreenMethods(conn)
    await screens.listen({
      offer: () => {
        throw new Error('no screen service')
      },
    })
    expect(await deliver('ext.phoneScreen.offer', { linkId: 'l1' })).toEqual({ accept: false })

    vi.mocked(conn.sendRequest).mockRejectedValueOnce(new Error('needs-elevation phone-screens'))
    expect(await screens.request('l1', 'phone.capture')).toEqual({
      ok: false,
      error: 'failed',
      message: 'needs-elevation phone-screens',
    })
    expect(conn.sendRequest).toHaveBeenLastCalledWith('ext.phoneScreens.request', {
      linkId: 'l1',
      method: 'phone.capture',
      params: undefined,
    })
  })
})
