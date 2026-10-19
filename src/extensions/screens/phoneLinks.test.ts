import type {
  PhoneScreenLink,
  PhoneScreenReply,
  PhoneScreensController,
} from '@aurigax-ai/ostia-extension-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateGate } from './createGate'
import { panelHandlers } from './panelApi'
import { PhoneLinks } from './phoneLinks'
import { createLeased, serviceVersion } from './screensCli'
import { ScreensService } from './screensService'
import { type FakeScreens, fakeScreens, translate } from './testFake'
import { Viewers } from './viewers'

const LINK: PhoneScreenLink = {
  linkId: 'link-1',
  sessionId: 'w1',
  width: 1080,
  height: 2400,
  density: 2.75,
  rotation: 0,
  level: 'control',
  limitSec: 900,
  endsAt: Date.now() + 900_000,
  overlayHeight: 96,
  label: 'Check the build',
  device: { id: 'dev_1', name: 'Pixel\u202e 8' },
}

describe('PhoneLinks', () => {
  let fake: FakeScreens
  let service: ScreensService
  let links: PhoneLinks
  let controller: PhoneScreensController
  let request: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<PhoneScreenReply>>>
  let ask: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<PhoneScreenReply>>>
  let changed: string[]
  let now: number

  const start = (version = '0.1.4') => {
    fake = fakeScreens({ version })
    service = new ScreensService()
    request = vi.fn(async () => ({ ok: true as const, data: {} }))
    ask = vi.fn(async () => ({ ok: true as const, data: null }))
    changed = []
    now = 1_000
    links = new PhoneLinks({
      phone: { request: request as never, ask: ask as never },
      service,
      version: serviceVersion,
      prepare: async () => {},
      lease: createLeased,
      changed: (workspaceId) => changed.push(workspaceId),
      now: () => now,
    })
    controller = links.controller()
  }

  const screenId = (): string => {
    const [screen] = service.registry.inWorkspace('w1')
    if (!screen) throw new Error('no phone screen')
    return screen.id
  }

  beforeEach(() => start())
  afterEach(() => {
    service.stopAllNow()
    fake.restore()
  })

  it('PHD-C25 takes an offer as a leased phone screen of the workspace', async () => {
    expect(await controller.offer(LINK)).toBe(true)
    expect(fake.calls()).toContain('daemon create --lease workspace:w1')
    const [listed] = await service.shown('w1')
    expect(listed).toMatchObject({ backend: 'phone', width: 1080, height: 2400 })
    expect(links.view(screenId())).toEqual({
      device: 'Pixel  8',
      level: 'control',
      endsAt: LINK.endsAt,
      state: 'running',
      foreground: '',
      watching: false,
    })
    expect(links.linksIn('w1')).toBe(1)
    expect(changed).toEqual(['w1'])
  })

  it('PHD-C26 relays the daemon calls to the phone and its answers back', async () => {
    await controller.offer(LINK)
    const id = screenId()
    request.mockResolvedValueOnce({ ok: true, data: { target: { text: 'OK' } } })
    request.mockResolvedValueOnce({ ok: false, error: 'paused', data: { reason: 'human-touch' } })
    fake.phoneCall(id, { type: 'call', call: 1, method: 'phone.tap', params: { x: 1, y: 2 } })
    fake.phoneCall(id, { type: 'call', call: 2, method: 'phone.swipe', params: {} })
    await vi.waitFor(() => expect(fake.phoneReplies(id)).toHaveLength(2))
    expect(request).toHaveBeenCalledWith('link-1', 'phone.tap', { x: 1, y: 2 })
    expect(fake.phoneReplies(id)).toEqual([
      { type: 'reply', call: 1, result: { target: { text: 'OK' } } },
      { type: 'reply', call: 2, error: { code: 'paused', reason: 'human-touch' } },
    ])
  })

  it('PHD-C27 passes the phone state to the daemon and ends the screen with the link', async () => {
    await controller.offer(LINK)
    const id = screenId()
    controller.event?.({
      linkId: 'link-1',
      kind: 'state',
      payload: { state: 'paused', reason: 'human-touch', width: 1080, height: 2400 },
    })
    controller.event?.({
      linkId: 'link-1',
      kind: 'foreground',
      payload: { package: 'com.android.settings', label: 'Settings\u0007' },
    })
    expect(links.view(id)).toMatchObject({ state: 'paused', foreground: 'Settings' })
    await vi.waitFor(() =>
      expect(fake.phoneReplies(id)).toEqual([
        { type: 'state', state: 'paused', width: 1080, height: 2400 },
      ]),
    )
    controller.event?.({ linkId: 'link-1', kind: 'ended', payload: { reason: 'closed' } })
    await vi.waitFor(() => expect(service.registry.get(id)).toBeUndefined())
    expect(links.linksIn('w1')).toBe(0)
    expect(request).not.toHaveBeenCalledWith('link-1', 'phone.stop', {})
  })

  it('PHD-C28 stops the phone session when the screen is stopped on the desktop', async () => {
    await controller.offer(LINK)
    expect((await service.stop(screenId())).ok).toBe(true)
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('link-1', 'phone.stop', {}))
    expect(links.linksIn('w1')).toBe(0)
  })

  it('PHD-C29 refuses an offer when the screens service has no phone backend yet', async () => {
    service.stopAllNow()
    fake.restore()
    start('0.1.3')
    expect(await controller.offer(LINK)).toBe(false)
    expect(fake.calls().filter((call) => call.startsWith('daemon create'))).toEqual([])
  })

  it('PHD-C29 gives up an offer that takes longer than the phone waits, closing the late lease', async () => {
    const destroy = vi.fn()
    const adopt = vi.spyOn(service, 'adopt')
    const version = vi.fn(async () => '0.1.4')
    const late = new PhoneLinks({
      phone: { request: request as never, ask: ask as never },
      service,
      version,
      prepare: async () => {},
      lease: async (_req, timeoutMs) => {
        expect(timeoutMs).toBeLessThanOrEqual(4_000)
        now += 4_500
        return {
          ok: true,
          value: {
            screen: { id: 's9', agentToken: 'a', viewerToken: 'v', width: 1, height: 1 },
            lease: { destroy } as never,
          },
        }
      },
      changed: (workspaceId) => changed.push(workspaceId),
      now: () => now,
    })
    await late.warm()
    expect(await late.controller().offer(LINK)).toBe(false)
    expect(destroy).toHaveBeenCalled()
    expect(adopt).not.toHaveBeenCalled()
    expect(changed).toEqual([])
    expect(late.linksIn('w1')).toBe(0)
    expect(version).toHaveBeenCalledTimes(1)
  })

  it('PHD-C30 streams frames only while watched and asks the phone for a session', async () => {
    await controller.offer(LINK)
    const id = screenId()
    const header = { seq: 1, width: 4, height: 4, screenWidth: 4, screenHeight: 4, blocked: false }
    controller.frame?.({ linkId: 'link-1', header, jpeg: Buffer.from([0xff]) })
    expect(links.latest(id)).toBeNull()

    expect(await links.watch(id, true)).toBe(true)
    expect(request).toHaveBeenLastCalledWith('link-1', 'phone.stream', { fps: 2, maxSide: 900 })
    controller.frame?.({ linkId: 'link-1', header, jpeg: Buffer.from([0xff, 0xd8]) })
    expect(links.latest(id)).toEqual({ seq: 1, jpeg: '/9g=' })

    now += 11_000
    controller.frame?.({ linkId: 'link-1', header: { ...header, seq: 2 }, jpeg: Buffer.from([1]) })
    await vi.waitFor(() =>
      expect(request).toHaveBeenLastCalledWith('link-1', 'phone.stream', { fps: 0 }),
    )
    expect(links.latest(id)).toBeNull()

    expect(links.askedRecently('w2')).toBe(false)
    expect(await links.ask('w2')).toBe(true)
    expect(ask).toHaveBeenCalledWith('w2')
    expect(links.askedRecently('w2')).toBe(true)
    now += 61_000
    expect(links.askedRecently('w2')).toBe(false)
  })
})

describe('the Screens panel with a phone', () => {
  it('PHD-C31 lists the phone, watches it only in its own workspace and asks the phone', async () => {
    const fake = fakeScreens({ version: '0.1.4' })
    const service = new ScreensService()
    const request = vi.fn(async () => ({ ok: true as const, data: {} }))
    const ask = vi.fn(async () => ({ ok: true as const, data: null }))
    const links = new PhoneLinks({
      phone: { request: request as never, ask: ask as never },
      service,
      version: serviceVersion,
      prepare: async () => {},
      lease: createLeased,
      changed: () => {},
      now: () => Date.now(),
    })
    const panel = panelHandlers({
      service,
      gate: new CreateGate({
        confirm: async () => true,
        card: () => ({ title: 't', message: 'm' }),
      }),
      phones: () => links,
      translate,
      installState: () => ({ service: true, missingPrograms: [], systemInstall: null }),
      confirm: async () => true,
      openTerminal: async () => ({ ok: true, paneId: 'p1' }),
      sandboxDomains: async () => ({ ok: true, domains: [] }),
      viewers: new Viewers(),
      now: () => Date.now(),
    })
    const scope = (workspaceId: string) => ({
      workspaceId,
      locale: 'en',
      panel: 'p',
      sandboxed: false,
    })
    try {
      await links.controller().offer(LINK)
      const state = (await panel.state({}, scope('w1'))) as {
        data: { screens: { id: string; phone?: unknown }[]; phones: unknown }
      }
      const [phone] = state.data.screens
      expect(phone.phone).toMatchObject({ level: 'control', state: 'running' })
      expect(state.data.phones).toEqual({ listening: true, asked: false })

      expect(await panel.watch({ id: phone.id, on: true }, scope('w2'))).toMatchObject({
        ok: false,
      })
      expect(await panel.watch({ id: phone.id, on: true }, scope('w1'))).toEqual({ ok: true })
      expect(await panel.frame({ id: phone.id }, scope('w2'))).toEqual({ ok: true, data: null })

      expect(await panel.ask({}, scope('w3'))).toEqual({ ok: true })
      expect(ask).toHaveBeenCalledWith('w3')
      const asked = (await panel.state({}, scope('w3'))) as { data: { phones: unknown } }
      expect(asked.data.phones).toEqual({ listening: true, asked: true })
    } finally {
      service.stopAllNow()
      fake.restore()
    }
  })
})
