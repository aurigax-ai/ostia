import type { PhoneScreenEvent } from '@aurigax-ai/ostia-extension-sdk/contract/phoneScreens'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LinkSocket, type ScreenLinkController, ScreenLinks } from './screenLinks'

const NOW = 1_800_000_000_000
const device = { deviceId: 'dev_1', name: 'Pixel', caps: ['read', 'notify'] }

function fakeSocket() {
  const sent: Array<Record<string, unknown>> = []
  const closes: Array<[number, string]> = []
  const ws: LinkSocket = {
    readyState: 1,
    OPEN: 1,
    send: (data) => sent.push(JSON.parse(data)),
    close: (code, reason) => closes.push([code, reason]),
  }
  return { ws, sent, closes }
}

function controllerWith(offer: () => Promise<boolean> = async () => true) {
  const events: PhoneScreenEvent[] = []
  const controller: ScreenLinkController = {
    offer,
    frame: () => {},
    event: (event) => events.push(event),
  }
  return { controller, events }
}

function params(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 's1',
    width: 1080,
    height: 2400,
    density: 2.75,
    rotation: 90,
    level: 'control',
    limitSec: 300,
    endsAt: NOW + 300_000,
    overlayHeight: 0,
    label: '',
    ...over,
  }
}

function newLinks() {
  return new ScreenLinks({
    listWorkspaces: async () => [
      { workspaceId: 's1', name: 'One', kind: 'terminal', workDir: '/w', state: 'idle' },
    ],
    askPhones: vi.fn(),
    notifiedDevices: () => [],
    agentRunning: () => true,
    log: vi.fn(),
    now: () => Date.now(),
  })
}

describe('ScreenLinks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => vi.useRealTimers())

  it('PHD-C8 keeps the link open at endsAt and closes it 4005 five seconds later', async () => {
    const links = newLinks()
    const { controller, events } = controllerWith()
    links.listen(controller)
    const { ws, closes } = fakeSocket()
    const started = await links.start(ws, device, params())
    const linkId = (started as { result: { screenId: string } }).result.screenId

    await vi.advanceTimersByTimeAsync(300_000)
    expect(closes).toEqual([])
    await vi.advanceTimersByTimeAsync(4_999)
    expect(closes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(closes).toEqual([[4005, 'time-limit']])
    expect(events).toEqual([{ linkId, kind: 'ended', payload: { reason: 'time-limit' } }])
  })

  it('answers a request the phone leaves unanswered for 75 s with timeout and drops the late answer', async () => {
    const links = newLinks()
    const { controller } = controllerWith()
    links.listen(controller)
    const { ws, sent } = fakeSocket()
    const started = await links.start(ws, device, params())
    const linkId = (started as { result: { screenId: string } }).result.screenId

    const reply = links.request(controller, linkId, 'phone.tree', undefined)
    expect(sent).toEqual([{ jsonrpc: '2.0', id: 1, method: 'phone.tree', params: {} }])
    await vi.advanceTimersByTimeAsync(74_999)
    let settled = false
    void reply.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await reply).toEqual({ ok: false, error: 'timeout' })
    expect(links.fromPhone(ws, { jsonrpc: '2.0', id: 1, result: { nodes: [] } })).toBe(true)
  })

  it('tells the controller a link ended when the phone closed it while the offer was out', async () => {
    const links = newLinks()
    let accept: (value: boolean) => void = () => {}
    const { controller, events } = controllerWith(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve
        }),
    )
    links.listen(controller)
    const { ws } = fakeSocket()
    const starting = links.start(ws, device, params())
    await vi.advanceTimersByTimeAsync(0)
    links.closed(ws, 1000)
    accept(true)
    expect(await starting).toMatchObject({ ok: false })
    expect(events).toEqual([expect.objectContaining({ kind: 'ended' })])
  })

  it('refuses a link without the read cap, odd params, and an offer the controller lets lapse', async () => {
    const links = newLinks()
    const { controller } = controllerWith(() => new Promise<boolean>(() => {}))
    links.listen(controller)
    const { ws } = fakeSocket()
    expect(await links.start(ws, { ...device, caps: ['notify'] }, params())).toMatchObject({
      code: -32003,
      data: { cap: 'read' },
    })
    for (const odd of [
      { width: 0 },
      { rotation: 45 },
      { level: 'drive' },
      { overlayHeight: 2401 },
      { agent: 'bash' },
      { endsAt: NOW - 1 },
      { label: 'x'.repeat(201) },
    ]) {
      expect(await links.start(ws, device, params(odd))).toMatchObject({ message: 'bad-params' })
    }
    const lapsing = links.start(ws, device, params())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await lapsing).toMatchObject({ code: -32004, message: 'no-controller' })
    expect(links.isLink(ws)).toBe(false)
  })

  it('drops a frame whose header is too long, cut short or not the contract shape', async () => {
    const frames: unknown[] = []
    const links = newLinks()
    const { controller } = controllerWith()
    links.listen({ ...controller, frame: (_id, header) => frames.push(header) })
    const { ws } = fakeSocket()
    await links.start(ws, device, params())
    const frame = (header: string, length = Buffer.byteLength(header)): Buffer => {
      const size = Buffer.alloc(4)
      size.writeUInt32BE(length)
      return Buffer.concat([Buffer.from([0x10]), size, Buffer.from(header), Buffer.from([0xff])])
    }
    const good = '{"seq":0,"width":1,"height":1,"screenWidth":1,"screenHeight":1,"blocked":true}'
    links.frame(ws, frame(good, 5_000))
    links.frame(ws, frame(good, Buffer.byteLength(good) + 1))
    links.frame(ws, frame('{"seq":-1}'))
    links.frame(ws, Buffer.from([0x01, 0, 0, 0, 0]))
    expect(frames).toEqual([])
    links.frame(ws, frame(good))
    expect(frames).toHaveLength(1)
  })
})
