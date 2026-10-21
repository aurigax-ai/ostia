import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentResume } from '../../shared/agents/agentResume'
import type { PaneIdentity } from '../control/idRegistry'
import { type ParkActDeps, parkPane } from './parkAct'
import { ParkedStore } from './parkedStore'

const identity = {
  kind: 'pane',
  windowId: '1',
  workspaceId: 'w1',
  paneId: 'p1',
  externalId: 'x1',
} as unknown as PaneIdentity

const resume: AgentResume = { agent: 'claude', id: 's1', cwd: '/home/u/api' }

function setup(over: Partial<ParkActDeps> = {}) {
  const store = new ParkedStore(join(mkdtempSync(join(tmpdir(), 'park-')), 'p.json'), () => 5)
  const deps: ParkActDeps = {
    store,
    identityOf: (paneId) => (paneId === 'p1' ? identity : undefined),
    workspaceKind: async () => 'terminal',
    isScratch: () => false,
    isSandboxed: () => false,
    isRemote: () => false,
    agentRunning: () => true,
    resumeOf: async () => resume,
    paneCwd: () => '/home/u/api',
    attentionState: async () => 'done',
    busy: async () => null,
    closing: () => 'Export test is flaky on CI; next: rerun with --repeat 20',
    title: async () => 'export-tests',
    redact: async (text) => text,
    ...over,
  }
  return { deps, store }
}

describe('parkPane', () => {
  it('stores the session with the agent’s closing line and the note, then answers the id', async () => {
    const { deps, store } = setup()
    const res = await parkPane(deps, 'w1', 'p1', 'after lunch')
    expect(res).toMatchObject({ ok: true, title: 'export-tests' })
    expect(store.list('w1')).toMatchObject([
      {
        title: 'export-tests',
        summary: 'Export test is flaky on CI; next: rerun with --repeat 20',
        note: 'after lunch',
        resume: { agent: 'claude', id: 's1', cwd: '/home/u/api' },
      },
    ])
  })

  it.each([
    [
      'a manager pane',
      { identityOf: () => ({ ...identity, manager: true }) as PaneIdentity },
      'manager',
    ],
    ['a scratch workspace', { isScratch: () => true }, 'scratch'],
    ['a sandboxed workspace', { isSandboxed: () => true }, 'sandboxed'],
    ['a remote pane', { isRemote: () => true }, 'remote'],
    ['a pane with no agent running', { agentRunning: () => false }, 'no-agent'],
    ['an agent with no resume token', { resumeOf: async () => null }, 'no-session'],
    ['an agent working', { attentionState: async () => 'working' }, 'working'],
    [
      'an agent with background work',
      { busy: async () => 'background-task' as const },
      'background-task',
    ],
    ['an agent with a subagent', { busy: async () => 'subagent' as const }, 'subagent'],
    ['processes it cannot read', { busy: async () => 'unknown' as const }, 'unknown'],
    ['a closed workspace', { workspaceKind: async () => null }, 'workspace-closed'],
  ] as [string, Partial<ParkActDeps>, string][])(
    'refuses %s and stores nothing',
    async (_name, over, reason) => {
      const { deps, store } = setup(over)
      expect(await parkPane(deps, 'w1', 'p1', '')).toEqual({ ok: false, reason })
      expect(store.list('w1')).toHaveLength(0)
    },
  )

  it('refuses a pane of another workspace and an unknown pane', async () => {
    const { deps } = setup()
    expect(await parkPane(deps, 'w2', 'p1', '')).toEqual({ ok: false, reason: 'unavailable' })
    expect(await parkPane(deps, 'w1', 'nope', '')).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('parks without a summary when the secret scan fails, still redacting the note it keeps', async () => {
    const { deps, store } = setup({
      redact: vi.fn(async () => {
        throw new Error('scan failed')
      }),
    })
    expect(await parkPane(deps, 'w1', 'p1', 'secret')).toMatchObject({ ok: true })
    expect(store.list('w1')[0]).not.toHaveProperty('summary')
    expect(store.list('w1')[0]).not.toHaveProperty('note')
  })

  it('stores the redacted text, never the original', async () => {
    const { deps, store } = setup({ redact: async (t) => t.replace('sk-abc', '[redacted]') })
    await parkPane(deps, 'w1', 'p1', 'use sk-abc')
    expect(store.list('w1')[0]?.note).toBe('use [redacted]')
  })

  it('takes the folder from the pane when the agent reported none, and refuses with none at all', async () => {
    const withoutCwd = setup({ resumeOf: async () => ({ agent: 'claude', id: 's1' }) })
    expect(await parkPane(withoutCwd.deps, 'w1', 'p1', '')).toMatchObject({ ok: true })
    expect(withoutCwd.store.list('w1')[0]?.resume.cwd).toBe('/home/u/api')
    const none = setup({
      resumeOf: async () => ({ agent: 'claude', id: 's1' }),
      paneCwd: () => undefined,
    })
    expect(await parkPane(none.deps, 'w1', 'p1', '')).toEqual({ ok: false, reason: 'no-session' })
  })

  it('keeps the agent name as the title when the pane list has none', async () => {
    const { deps } = setup({ title: async () => undefined })
    expect(await parkPane(deps, 'w1', 'p1', '')).toMatchObject({ ok: true, title: 'claude' })
  })

  it('refuses when the workspace already holds the most it keeps', async () => {
    const { deps, store } = setup()
    for (let i = 0; i < 25; i++) {
      store.park({
        workspaceId: 'w1',
        resume: { agent: 'claude', id: `y${i}`, cwd: '/a' },
        title: 't',
      })
    }
    expect(await parkPane(deps, 'w1', 'p1', '')).toEqual({ ok: false, reason: 'too-many' })
  })
})
