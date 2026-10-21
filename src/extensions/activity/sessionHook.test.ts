import type { ExtensionCaller } from '@aurigax-ai/ostia-extension-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newRecordId } from './hookEvent'
import { RememberStore } from './remember'
import type { RememberItem } from './rememberItem'
import { sessionHook } from './sessionHook'

const NOW = Date.UTC(2026, 9, 14, 12)

function item(extra: Partial<RememberItem> = {}): RememberItem {
  return {
    v: 1,
    id: newRecordId(),
    t: NOW,
    pane: 'p1',
    session: 's1',
    agent: 'claude',
    text: 'Bisect fixture order',
    state: 'open',
    ...extra,
  }
}

const caller = (extra: Partial<ExtensionCaller> = {}): ExtensionCaller =>
  ({ kind: 'pane', paneId: 'p1', workspaceId: 'w1', capabilities: [], ...extra }) as ExtensionCaller

interface Answer {
  ok: boolean
  text?: string
  data?: { count: number }
}

describe('the SessionStart hook that gives tasks back', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const make = () => {
    const store = new RememberStore({ dir: null, now: () => NOW })
    store.add('w1', item(), false)
    let changes = 0
    const known = { current: null as { agent: string; session: string } | null }
    const hook = sessionHook({
      store,
      paneSession: async () => known.current,
      now: () => NOW,
      days: () => 14,
      changed: () => changes++,
    })
    const run = async (agent: string, payload: unknown, who = caller()) =>
      (await hook({ argv: [agent], stdin: JSON.stringify(payload) }, who)) as Answer
    return { store, run, known, changes: () => changes }
  }

  it.each(['resume', 'compact', 'clear'])('gives the open tasks after a %s', async (source) => {
    const { run } = make()
    const res = await run('claude', { session_id: 's1', source })
    expect(res.ok).toBe(true)
    expect(res.text).toContain('Bisect fixture order')
    expect(res.data?.count).toBe(1)
  })

  it.each(['startup', 'fork', ''])('gives nothing at a %s', async (source) => {
    const { run } = make()
    expect((await run('claude', { session_id: 's1', source })).text).toBeUndefined()
  })

  it('adopts a pane’s tasks into the new session id at a clear', async () => {
    const { run, store, changes } = make()
    const res = await run('claude', { session_id: 's2', source: 'clear' })
    expect(res.text).toContain('Bisect fixture order')
    expect(store.items('w1')[0]?.session).toBe('s2')
    expect(changes()).toBe(1)
  })

  it('gives another session nothing', async () => {
    const { run } = make()
    expect((await run('codex', { session_id: 'other', source: 'resume' })).text).toBeUndefined()
  })

  it('gives the Agent pane its tasks when a session opens, with no pane and no source', async () => {
    const { run } = make()
    const res = await run(
      'agent',
      { session_id: 's1' },
      caller({ kind: 'user', paneId: undefined }),
    )
    expect(res.text).toContain('Bisect fixture order')
  })

  it('gives nothing to a manager, a remote pane or a caller with no workspace, or for a bad payload', async () => {
    const { run } = make()
    const payload = { session_id: 's1', source: 'resume' }
    expect((await run('claude', payload, caller({ manager: true }))).text).toBeUndefined()
    expect(
      (await run('claude', payload, caller({ remote: { host: 'h' } as never }))).text,
    ).toBeUndefined()
    expect((await run('claude', payload, caller({ workspaceId: undefined }))).text).toBeUndefined()
    expect((await run('claude', { source: 'resume' })).text).toBeUndefined()
    expect((await run('claude', { session_id: 'bad id', source: 'resume' })).text).toBeUndefined()
  })

  it('gives nothing for an expired or done task', async () => {
    const store = new RememberStore({ dir: null, now: () => NOW })
    store.add('w1', item({ t: NOW - 20 * 86_400_000 }), false)
    store.add('w1', item({ state: 'done', doneAt: NOW }), false)
    const hook = sessionHook({
      store,
      paneSession: async () => null,
      now: () => NOW,
      days: () => 14,
      changed: () => {},
    })
    const res = (await hook(
      { argv: ['claude'], stdin: JSON.stringify({ session_id: 's1', source: 'resume' }) },
      caller(),
    )) as Answer
    expect(res.text).toBeUndefined()
  })

  it('refuses a session id that is not the one main knows for the pane, for a read and a clear', async () => {
    const { run, known, store } = make()
    known.current = { agent: 'claude', session: 's1' }
    expect((await run('claude', { session_id: 's1', source: 'resume' })).text).toContain('Bisect')
    expect((await run('claude', { session_id: 'forged', source: 'resume' })).text).toBeUndefined()
    expect((await run('codex', { session_id: 's1', source: 'resume' })).text).toBeUndefined()
    vi.useFakeTimers()
    const clear = run('claude', { session_id: 'forged', source: 'clear' })
    await vi.advanceTimersByTimeAsync(2000)
    expect((await clear).text).toBeUndefined()
    expect(store.items('w1')[0]?.session).toBe('s1')
  })

  it('waits for main to learn the new session id before it hands tasks over at a clear', async () => {
    const { run, known, store } = make()
    known.current = { agent: 'claude', session: 's1' }
    vi.useFakeTimers()
    const clear = run('claude', { session_id: 's2', source: 'clear' })
    await vi.advanceTimersByTimeAsync(350)
    known.current = { agent: 'claude', session: 's2' }
    await vi.advanceTimersByTimeAsync(400)
    expect((await clear).text).toContain('Bisect')
    expect(store.items('w1')[0]?.session).toBe('s2')
  })
})
