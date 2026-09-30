import { describe, expect, it, vi } from 'vitest'
import type { AssistPoint, AssistResponse } from '../shared/assist'
import { type AssistHost, type AssistSender, createAssistRouter } from './assistIpc'
import type { AssistCallOptions } from './extensionHost'

function fakeSender(id = 1) {
  let onDestroyed: (() => void) | null = null
  const sent: { channel: string; payload: unknown }[] = []
  const sender: AssistSender = {
    id,
    send: (channel, payload) => sent.push({ channel, payload }),
    isDestroyed: () => false,
    once: (_event, listener) => {
      onDestroyed = listener
    },
  }
  return { sender, sent, destroy: () => onDestroyed?.() }
}

function hangingHost() {
  const calls: AssistCallOptions[] = []
  const host: AssistHost = {
    assistAvailability: () => ({}),
    assist: <P extends AssistPoint>(_point: P, _input: unknown, opts: AssistCallOptions = {}) => {
      calls.push(opts)
      return new Promise<AssistResponse<P>>((resolve) => {
        opts.token?.onCancellationRequested(() => resolve({ ok: false, error: 'cancelled' }))
      })
    },
  }
  return { host, calls }
}

describe('createAssistRouter', () => {
  it('forwards chunks to the window that asked, tagged with its request id', async () => {
    const host: AssistHost = {
      assistAvailability: () => ({}),
      assist: async <P extends AssistPoint>(
        _point: P,
        _input: unknown,
        opts: AssistCallOptions = {},
      ) => {
        opts.onChunk?.('hel')
        opts.onChunk?.('lo')
        return { ok: true, result: { text: 'hello' } } as AssistResponse<P>
      },
    }
    const { sender, sent } = fakeSender()
    const router = createAssistRouter(() => host)
    const res = await router.request(sender, 'chat', 'r1', { messages: [] })
    expect(res).toEqual({ ok: true, result: { text: 'hello' } })
    expect(sent).toEqual([
      { channel: 'assist:chunk', payload: { requestId: 'r1', text: 'hel' } },
      { channel: 'assist:chunk', payload: { requestId: 'r1', text: 'lo' } },
    ])
  })

  it('cancels only the named request of the same window', async () => {
    const { host, calls } = hangingHost()
    const a = fakeSender(1)
    const router = createAssistRouter(() => host)
    const pending = router.request(a.sender, 'chat', 'r1', {})
    router.cancel(2, 'r1')
    expect(calls[0].token?.isCancellationRequested).toBe(false)
    router.cancel(1, 'r1')
    expect(await pending).toEqual({ ok: false, error: 'cancelled' })
    expect(router.pending()).toBe(0)
  })

  it('cancels everything a closed window left running', async () => {
    const { host } = hangingHost()
    const a = fakeSender(1)
    const router = createAssistRouter(() => host)
    const one = router.request(a.sender, 'chat', 'r1', {})
    const two = router.request(a.sender, 'command', 'r2', {})
    a.destroy()
    expect(await Promise.all([one, two])).toEqual([
      { ok: false, error: 'cancelled' },
      { ok: false, error: 'cancelled' },
    ])
  })

  it('refuses unknown points, bad or duplicate ids, and too many requests', async () => {
    const { host } = hangingHost()
    const { sender } = fakeSender()
    const router = createAssistRouter(() => host)
    expect(await router.request(sender, 'shell', 'r1', {})).toEqual({ ok: false, error: 'invalid' })
    expect(await router.request(sender, 'chat', 'bad id!', {})).toEqual({
      ok: false,
      error: 'invalid',
    })
    const open = Array.from({ length: 8 }, (_, i) => router.request(sender, 'chat', `q${i}`, {}))
    expect(await router.request(sender, 'chat', 'q0', {})).toEqual({ ok: false, error: 'invalid' })
    expect(await router.request(sender, 'chat', 'q9', {})).toEqual({ ok: false, error: 'busy' })
    for (let i = 0; i < 8; i++) router.cancel(sender.id, `q${i}`)
    await Promise.all(open)
  })

  it('answers unavailable without a host', async () => {
    const send = vi.fn()
    const router = createAssistRouter(() => null)
    expect(
      await router.request(
        { id: 1, send, isDestroyed: () => false, once: () => {} },
        'chat',
        'r1',
        {},
      ),
    ).toEqual({ ok: false, error: 'unavailable' })
  })
})
