import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlMethod, ControlMethodContext } from '../control/controlServer'
import type { PaneEntry } from './paneList'

const dataHome = mkdtempSync(join(tmpdir(), 'ostia-status-'))
process.env.XDG_DATA_HOME = dataHome

const methods = new Map<string, ControlMethod>()
vi.mock('../control/controlServer', () => ({
  registerControlMethod: (name: string, method: ControlMethod) => methods.set(name, method),
}))
const held = new Set<string>()
vi.mock('../control/controlAuth', async (original) => ({
  ...(await original<typeof import('../control/controlAuth')>()),
  connHasCap: (_conn: unknown, cap: string) => held.has(cap),
}))
const ensureCaps = vi.fn(async (..._args: unknown[]) => {})
vi.mock('../approvals/controlElevation', () => ({ ensureCaps }))

const { registerPaneStatusMethods, paneStateOf, staleMarks, statusOf, summarizeChanges } =
  await import('./paneStatus')
const { PaneJournal } = await import('./paneJournal')
const { enqueue, flushBus, resetBus, takeMail, failPaneMail } = await import('../agents/busStore')
const { markManager, registerPane, registerScript } = await import('../control/idRegistry')

const caller = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'st-caller' })
const worker = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'st-worker' })
const faraway = registerPane({ windowId: 'w1', workspaceId: 'ws9', paneId: 'st-faraway' })
const second = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'st-second' })

const entries = new Map<string, Partial<PaneEntry>>()
const sandboxed = new Set<string>()
const confined = new Set<string>()
const scope = new Set<string>()
const children = new Set<string>()
const clock = { now: 100_000 }
const terminal = new Map<string, { running: boolean; lastExitCode?: number }>()
const journal = new PaneJournal({ terminal: (id) => terminal.get(id), now: () => clock.now })
const gitCalls: (string | undefined)[] = []
const wakingAt = new Map<string, number>()
const sharing = new Map<string, string[]>()

registerPaneStatusMethods({
  processPane: async () => [],
  visible: async () => () => true,
  inScope: async (ctx, workspaceId) =>
    ctx.identity.workspaceId === workspaceId || scope.has(workspaceId),
  isChild: (owner, paneId) => children.has(`${owner}>${paneId}`),
  isSandboxed: (workspaceId) => sandboxed.has(workspaceId),
  isConfined: (paneId) => confined.has(paneId),
  panes: async () =>
    [...entries].map(
      ([paneId, entry]) =>
        ({
          paneId,
          workspaceId: 'ws1',
          kind: 'terminal',
          title: 'worker',
          running: false,
          blockCount: 0,
          ...entry,
        }) as PaneEntry,
    ),
  journal,
  exited: () => false,
  wakingSince: (paneId) => wakingAt.get(paneId),
  conflicts: (externalId) => sharing.get(externalId) ?? [],
  git: async (_paneId, cwd) => {
    gitCalls.push(cwd)
    return cwd ? { branch: 'feat/x', ahead: 1, behind: 0, changed: 3 } : undefined
  },
  now: () => clock.now,
})

function ask(identity: typeof caller, panes: unknown) {
  const method = methods.get('pane.status')
  if (!method) throw new Error('no pane.status')
  return method.handler({ panes }, {
    identity,
    authed: {},
    conn: { onClose: () => ({ dispose: () => {} }) },
  } as unknown as ControlMethodContext) as Promise<{
    panes: ReturnType<typeof statusOf>[]
  }>
}

beforeEach(async () => {
  await resetBus()
  rmSync(join(dataHome, 'ostia', 'bus.json'), { force: true })
  entries.clear()
  sandboxed.clear()
  confined.clear()
  scope.clear()
  children.clear()
  held.clear()
  terminal.clear()
  gitCalls.length = 0
  wakingAt.clear()
  sharing.clear()
  ensureCaps.mockClear()
  ensureCaps.mockImplementation(async () => {})
  journal.forget(worker.paneId, caller.externalId)
  journal.forget(faraway.paneId)
  entries.set(worker.externalId, { agent: 'claude', cwd: '/work/x' })
})

afterAll(async () => {
  await flushBus()
  rmSync(dataHome, { recursive: true, force: true })
})

describe('paneStateOf', () => {
  const entry = (over: Partial<PaneEntry>) => ({ running: false, ...over }) as PaneEntry

  it('takes an agent’s reported state, then hibernation and waking before it', () => {
    for (const agentState of ['working', 'waiting', 'done', 'error']) {
      expect(paneStateOf(entry({ agent: 'claude', agentState }), false)).toBe(agentState)
    }
    expect(
      paneStateOf(entry({ agent: 'claude', agentState: 'done', hibernated: true }), false),
    ).toBe('hibernated')
    expect(paneStateOf(entry({ agent: 'claude', waking: true }), false)).toBe('waking')
  })

  it('tells an idle agent, a finished pane, a running command and a quiet shell apart', () => {
    expect(paneStateOf(entry({ agent: 'codex' }), false)).toBe('idle')
    expect(paneStateOf(entry({}), true)).toBe('exited')
    expect(paneStateOf(entry({ running: true }), false)).toBe('working')
    expect(paneStateOf(entry({}), false)).toBe('shell')
    expect(paneStateOf(undefined, false)).toBe('exited')
  })
})

describe('summarizeChanges', () => {
  it('lists the states passed through, counts commands and failures, and flags closing and mail', () => {
    const summary = summarizeChanges(false, [
      { kind: 'state', state: 'working', from: 'idle', at: 1, seq: 1 },
      { kind: 'command', exitCode: 0, at: 2, seq: 2 },
      { kind: 'command', exitCode: 1, at: 3, seq: 3 },
      { kind: 'command', at: 4, seq: 4 },
      { kind: 'state', state: 'done', from: 'working', at: 5, seq: 5 },
      { kind: 'closing', at: 6, seq: 6 },
      { kind: 'mail', at: 7, seq: 7 },
    ])
    expect(summary).toEqual({
      first: false,
      states: ['idle', 'working', 'done'],
      commands: 3,
      failed: 1,
      closing: true,
      mail: 1,
    })
  })
})

describe('statusOf', () => {
  const facts = {
    exited: false,
    changes: { first: true, states: [], commands: 0, failed: 0, closing: false, mail: 0 },
    mail: { queued: 0, failed: 0, sentQueued: 0, sentFailed: 0 },
  }

  it('shows the exit code only for a pane that is not running a command', () => {
    const done = { paneId: 'abcdefgh-1', title: '', running: false, lastExitCode: 1 } as PaneEntry
    expect(statusOf(done, facts)).toMatchObject({ title: 'abcdefgh', exitCode: 1, state: 'shell' })
    expect(statusOf({ ...done, running: true }, facts)).not.toHaveProperty('exitCode')
  })

  it('caps the closing line', () => {
    const entry = { paneId: 'p', title: 't', running: false } as PaneEntry
    expect(statusOf(entry, { ...facts, closing: 'x'.repeat(500) }).closing).toHaveLength(280)
  })
})

describe('staleMarks', () => {
  it('marks mail queued past ten minutes, a wake past its budget and the last failure', () => {
    expect(
      staleMarks({
        oldestQueuedMs: 38 * 60_000,
        wakingMs: 3 * 60_000,
        lastFailure: 'expired:hibernated',
      }),
    ).toEqual(['mail queued 38m', 'waking 3m', 'mail failed:expired:hibernated'])
  })

  it('marks nothing that is still within its budget', () => {
    expect(staleMarks({ oldestQueuedMs: 9 * 60_000, wakingMs: 119_000 })).toEqual([])
    expect(staleMarks({})).toEqual([])
  })
})

describe('pane.status', () => {
  it('answers the worker’s facts: state, closing line, exit, git and mail', async () => {
    entries.set(worker.externalId, {
      agent: 'claude',
      agentState: 'done',
      cwd: '/work/x',
      lastExitCode: 0,
    })
    journal.onChange(worker.paneId, { kind: 'attention', attention: { state: 'working' } })
    clock.now += 4 * 60_000
    journal.onChange(worker.paneId, { kind: 'attention', attention: { state: 'done' } })
    journal.report(worker.paneId, 'done', undefined, 'PR #9 open, unit green')
    clock.now += 2 * 60_000
    enqueue({ from: worker.externalId, to: caller.externalId, text: 'question' })
    enqueue({ from: caller.externalId, to: worker.externalId, text: 'task' })

    const { panes } = await ask(caller, [worker.externalId])
    expect(panes).toHaveLength(1)
    expect(panes[0]).toMatchObject({
      pane: worker.externalId,
      state: 'done',
      sinceMs: 2 * 60_000,
      closing: 'PR #9 open, unit green',
      exitCode: 0,
      git: { branch: 'feat/x', ahead: 1, behind: 0, changed: 3 },
      mail: { queued: 1, failed: 0, sentQueued: 1, sentFailed: 0 },
      changes: { first: true },
    })
    expect(gitCalls).toEqual(['/work/x'])
  })

  it('shows what changed since the caller last asked, once', async () => {
    await ask(caller, [worker.externalId])
    journal.onChange(worker.paneId, { kind: 'attention', attention: { state: 'working' } })
    terminal.set(worker.paneId, { running: true })
    journal.onChange(worker.paneId, { kind: 'state' })
    terminal.set(worker.paneId, { running: false, lastExitCode: 1 })
    journal.onChange(worker.paneId, { kind: 'state' })
    journal.onChange(worker.paneId, { kind: 'attention', attention: { state: 'done' } })

    const second = await ask(caller, [worker.externalId])
    expect(second.panes[0]?.changes).toEqual({
      first: false,
      states: ['working', 'done'],
      commands: 1,
      failed: 1,
      closing: false,
      mail: 0,
    })
    const third = await ask(caller, [worker.externalId])
    expect(third.panes[0]?.changes).toMatchObject({ first: false, states: [], commands: 0 })
  })

  it('counts failed mail to and from the pane', async () => {
    enqueue({ from: caller.externalId, to: worker.externalId, text: 'to a pane that closed' })
    enqueue({ from: worker.externalId, to: caller.externalId, text: 'from a worker, unread' })
    enqueue({ from: worker.externalId, to: caller.externalId, text: 'from a worker, read' })
    takeMail(caller.externalId, 'read', (m) => m.text?.endsWith(', read') === true)
    failPaneMail(worker.externalId)
    failPaneMail(caller.externalId)
    const { panes } = await ask(caller, [worker.externalId])
    expect(panes[0]?.mail).toEqual({ queued: 0, failed: 1, sentQueued: 0, sentFailed: 1 })
  })

  it('marks stuck mail, a slow wake and a failed message, as facts only', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      enqueue({ from: caller.externalId, to: worker.externalId, text: 'still waiting' })
      vi.setSystemTime(Date.now() + 11 * 60_000)
      wakingAt.set(worker.paneId, clock.now - 3 * 60_000)
      const stuck = await ask(caller, [worker.externalId])
      expect(stuck.panes[0]?.stale).toEqual(['mail queued 11m', 'waking 3m'])

      failPaneMail(worker.externalId)
      wakingAt.clear()
      const failed = await ask(caller, [worker.externalId])
      expect(failed.panes[0]?.stale).toEqual(['mail failed:pane-closed'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('names the panes that share the worker’s git worktree, by title', async () => {
    entries.set(second.externalId, { agent: 'codex', title: 'w-2' })
    sharing.set(worker.externalId, [second.externalId])
    const { panes } = await ask(caller, [worker.externalId])
    expect(panes[0]?.conflict).toEqual(['w-2'])
    const alone = await ask(caller, [second.externalId])
    expect(alone.panes[0]?.conflict).toEqual([])
  })

  it('asks read-other-pane for another pane, with all-workspaces outside reach', async () => {
    entries.set(faraway.externalId, { agent: 'claude' })
    await ask(caller, [worker.externalId, faraway.externalId])
    expect(ensureCaps).toHaveBeenCalledWith(
      {},
      caller,
      ['read-other-pane'],
      'pane.status',
      expect.any(String),
    )
    expect(ensureCaps).toHaveBeenCalledWith(
      {},
      caller,
      ['read-other-pane', 'all-workspaces'],
      'pane.status',
      expect.any(String),
    )
  })

  it('keeps a sandboxed caller inside the confined panes of its workspace, and hides the manager', async () => {
    sandboxed.add('ws1')
    await expect(ask(caller, [faraway.externalId])).rejects.toThrow('sandboxed')
    await expect(ask(caller, [worker.externalId])).rejects.toThrow('sandboxed')
    confined.add(worker.paneId)
    expect((await ask(caller, [worker.externalId])).panes).toHaveLength(1)
    const manager = registerPane({ windowId: 'w1', workspaceId: 'mgr', paneId: 'st-manager' })
    markManager('st-manager')
    sandboxed.clear()
    await expect(ask(caller, [manager.externalId])).rejects.toThrow('unknown-pane')
  })

  it('answers the other terminals of the caller’s workspace it may read when no pane is named', async () => {
    held.add('process')
    children.add(`${caller.paneId}>${worker.paneId}`)
    children.add(`${caller.paneId}>${second.paneId}`)
    entries.set(second.externalId, { agent: 'codex', title: 'w-2' })
    entries.set(caller.externalId, { agent: 'claude', title: 'me' })
    entries.set(faraway.externalId, { workspaceId: 'ws9', title: 'elsewhere' })
    entries.set('browser-1', { kind: 'browser', title: 'docs' })
    const res = await ask(caller, undefined)
    expect(res.panes.map((p) => p.pane).sort()).toEqual(
      [worker.externalId, second.externalId].sort(),
    )
    await expect(ask(registerScript('st-script'), undefined)).rejects.toThrow('bad-request: panes')
    held.clear()
    expect((await ask(caller, undefined)).panes).toEqual([])
    held.add('process')
    sandboxed.add('ws1')
    expect((await ask(caller, undefined)).panes).toEqual([])
  })

  it('refuses an empty or unknown pane list and a list over the cap', async () => {
    await expect(ask(caller, [])).rejects.toThrow('bad-request: panes')
    await expect(ask(caller, ['nope'])).rejects.toThrow('unknown-pane')
    await expect(
      ask(
        caller,
        Array.from({ length: 40 }, (_, i) => `p${i}`),
      ),
    ).rejects.toThrow('too-many: panes')
  })

  it('writes nothing to disk: no status file appears in the data folder', async () => {
    await ask(caller, [worker.externalId])
    await flushBus()
    const files = readdirSync(join(dataHome, 'ostia'), { recursive: true }).map(String)
    expect(files.filter((f) => f.includes('status') || f.includes('journal'))).toEqual([])
  })
})
