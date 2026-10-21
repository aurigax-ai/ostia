import type { ExtensionCaller } from '@aurigax-ai/ostia-extension-sdk'
import { describe, expect, it } from 'vitest'
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

describe('the SessionStart hook that gives tasks back', () => {
  const make = () => {
    const store = new RememberStore({ dir: null, now: () => NOW })
    store.add('w1', item(), false)
    let changes = 0
    const hook = sessionHook({ store, now: () => NOW, days: () => 14, changed: () => changes++ })
    const run = (agent: string, payload: unknown, who = caller()) =>
      hook({ argv: [agent], stdin: JSON.stringify(payload) }, who) as {
        ok: boolean
        text?: string
        data?: { count: number }
      }
    return { store, run, changes: () => changes }
  }

  it.each(['resume', 'compact', 'clear'])('gives the open tasks after a %s', (source) => {
    const { run } = make()
    const res = run('claude', { session_id: 's1', source })
    expect(res.ok).toBe(true)
    expect(res.text).toContain('Bisect fixture order')
    expect(res.data?.count).toBe(1)
  })

  it.each(['startup', 'fork', ''])('gives nothing at a %s', (source) => {
    const { run } = make()
    expect(run('claude', { session_id: 's1', source }).text).toBeUndefined()
  })

  it('adopts a pane’s tasks into the new session at a clear', () => {
    const { run, store, changes } = make()
    const res = run('claude', { session_id: 's2', source: 'clear' })
    expect(res.text).toContain('Bisect fixture order')
    expect(store.items('w1')[0]?.session).toBe('s2')
    expect(changes()).toBe(1)
  })

  it('gives another session nothing', () => {
    const { run } = make()
    expect(run('codex', { session_id: 'other', source: 'resume' }).text).toBeUndefined()
  })

  it('gives the Agent pane its tasks when a session opens, with no pane and no source', () => {
    const { run } = make()
    const res = run('agent', { session_id: 's1' }, caller({ kind: 'user', paneId: undefined }))
    expect(res.text).toContain('Bisect fixture order')
  })

  it('gives nothing to a manager, a remote pane or a caller with no workspace, or for a bad payload', () => {
    const { run } = make()
    const payload = { session_id: 's1', source: 'resume' }
    expect(run('claude', payload, caller({ manager: true })).text).toBeUndefined()
    expect(run('claude', payload, caller({ remote: { host: 'h' } as never })).text).toBeUndefined()
    expect(run('claude', payload, caller({ workspaceId: undefined })).text).toBeUndefined()
    expect(run('claude', { source: 'resume' }).text).toBeUndefined()
    expect(run('claude', { session_id: 'bad id', source: 'resume' }).text).toBeUndefined()
  })

  it('gives nothing for an expired or done task', () => {
    const store = new RememberStore({ dir: null, now: () => NOW })
    store.add('w1', item({ t: NOW - 20 * 86_400_000 }), false)
    store.add('w1', item({ state: 'done', doneAt: NOW }), false)
    const hook = sessionHook({ store, now: () => NOW, days: () => 14, changed: () => {} })
    const res = hook(
      { argv: ['claude'], stdin: JSON.stringify({ session_id: 's1', source: 'resume' }) },
      caller(),
    ) as { text?: string }
    expect(res.text).toBeUndefined()
  })
})
