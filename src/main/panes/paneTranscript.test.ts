import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlMethod, ControlMethodContext } from '../control/controlServer'
import type { PaneEntry } from './paneList'

const methods = new Map<string, ControlMethod>()
vi.mock('../control/controlServer', () => ({
  registerControlMethod: (name: string, method: ControlMethod) => methods.set(name, method),
}))
const ensureCaps = vi.fn(async (..._args: unknown[]) => {})
vi.mock('../approvals/controlElevation', () => ({ ensureCaps }))

const { registerPaneTranscriptMethods } = await import('./paneTranscript')
const { markManager, registerPane } = await import('../control/idRegistry')

const caller = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'tr-caller' })
const worker = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'tr-worker' })
const faraway = registerPane({ windowId: 'w1', workspaceId: 'ws9', paneId: 'tr-faraway' })

const entries = new Map<string, Partial<PaneEntry>>()
const sandboxed = new Set<string>()
const confined = new Set<string>()
const scope = new Set<string>()
const lines =
  vi.fn<
    (
      resume: { agent: string; id: string },
      bytes: number,
    ) => Promise<{ lines: string[]; truncated: boolean } | null>
  >()

registerPaneTranscriptMethods({
  processPane: async () => [],
  visible: async () => () => true,
  inScope: async (ctx, workspaceId) =>
    ctx.identity.workspaceId === workspaceId || scope.has(workspaceId),
  isChild: () => false,
  isSandboxed: (workspaceId) => sandboxed.has(workspaceId),
  isConfined: (paneId) => confined.has(paneId),
  panes: async () =>
    [...entries].map(
      ([paneId, entry]) =>
        ({
          paneId,
          workspaceId: 'ws1',
          kind: 'terminal',
          title: 't',
          running: false,
          blockCount: 0,
          ...entry,
        }) as PaneEntry,
    ),
  lines: lines as never,
})

function ask(identity: typeof caller, params: unknown) {
  const method = methods.get('pane.transcript')
  if (!method) throw new Error('no pane.transcript')
  return method.handler(params, {
    identity,
    authed: {},
    conn: { onClose: () => ({ dispose: () => {} }) },
  } as unknown as ControlMethodContext) as Promise<{ agent: string; turns: number; text: string }>
}

const claudeLines = [
  { type: 'user', message: { content: 'first task' } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'first answer' }] } },
  { type: 'user', message: { content: 'second task' } },
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
        { type: 'text', text: 'second answer\nwith detail' },
      ],
    },
  },
].map((entry) => JSON.stringify(entry))

beforeEach(() => {
  entries.clear()
  sandboxed.clear()
  confined.clear()
  scope.clear()
  ensureCaps.mockClear()
  lines.mockReset()
  lines.mockResolvedValue({ lines: claudeLines, truncated: false })
  entries.set(worker.externalId, { agent: 'claude', agentSessionId: 'sess-1' })
})

describe('pane.transcript', () => {
  it('answers the last turn by default: prompt, one line per tool call, the full final message', async () => {
    const res = await ask(caller, { pane: worker.externalId })
    expect(res).toEqual({
      agent: 'claude',
      turns: 1,
      text: '> second task\n· Bash: pnpm test\nsecond answer\nwith detail',
    })
    expect(lines).toHaveBeenCalledWith({ agent: 'claude', id: 'sess-1' }, 4 * 1024 * 1024)
  })

  it('answers the last N turns, or every turn with a larger read for full', async () => {
    expect((await ask(caller, { pane: worker.externalId, turns: 2 })).text).toContain(
      '> first task',
    )
    const full = await ask(caller, { pane: worker.externalId, full: true })
    expect(full.turns).toBe(2)
    expect(lines).toHaveBeenLastCalledWith({ agent: 'claude', id: 'sess-1' }, 32 * 1024 * 1024)
  })

  it('widens the window when the cut tail holds too few whole turns, and says when older turns are left out', async () => {
    lines.mockImplementation(async (_resume, bytes) =>
      bytes < 32 * 1024 * 1024
        ? { lines: claudeLines.slice(2), truncated: true }
        : { lines: claudeLines.slice(2), truncated: true },
    )
    const res = await ask(caller, { pane: worker.externalId, turns: 2 })
    expect(lines.mock.calls.map(([, bytes]) => bytes)).toEqual([
      4 * 1024 * 1024,
      16 * 1024 * 1024,
      32 * 1024 * 1024,
    ])
    expect(res.turns).toBe(1)
    expect(res).toMatchObject({ truncated: true })
  })

  it('shows only the whole turns of a cut tail and says older ones are left out', async () => {
    lines.mockResolvedValue({ lines: claudeLines.slice(1), truncated: true })
    const res = await ask(caller, { pane: worker.externalId, full: true })
    expect(res.text).not.toContain('first')
    expect(res).toMatchObject({ truncated: true })
  })

  it('refuses with too-large instead of an empty answer when the last turn does not fit', async () => {
    lines.mockResolvedValue({ lines: claudeLines.slice(3), truncated: true })
    await expect(ask(caller, { pane: worker.externalId })).rejects.toThrow('too-large')
  })

  it.each([
    [{ turns: 0 }, 'bad-request: turns'],
    [{ turns: 51 }, 'bad-request: turns'],
    [{ turns: 1.5 }, 'bad-request: turns'],
    [{ turns: '2' }, 'bad-request: turns'],
    [{ full: 'yes' }, 'bad-request: full'],
    [{ full: true, turns: 2 }, 'bad-request: turns with full'],
  ])('refuses %j', async (extra, message) => {
    await expect(ask(caller, { pane: worker.externalId, ...extra })).rejects.toThrow(message)
  })

  it('says why there is nothing to show', async () => {
    entries.set(worker.externalId, { agent: 'claude' })
    await expect(ask(caller, { pane: worker.externalId })).rejects.toThrow(
      'no-transcript: no agent session is known',
    )
    entries.set(worker.externalId, { agentSessionId: 'sess-1' })
    await expect(ask(caller, { pane: worker.externalId })).rejects.toThrow('no-transcript')
    entries.set(worker.externalId, { agent: 'claude', agentSessionId: 'sess-1' })
    lines.mockResolvedValue(null)
    await expect(ask(caller, { pane: worker.externalId })).rejects.toThrow(
      'no-transcript: the agent has no transcript file yet',
    )
  })

  it('asks the same reach as pane read, with all-workspaces outside it', async () => {
    entries.set(faraway.externalId, { agent: 'codex', agentSessionId: 'c-1' })
    await ask(caller, { pane: worker.externalId })
    await ask(caller, { pane: faraway.externalId })
    expect(ensureCaps).toHaveBeenCalledWith(
      {},
      caller,
      ['read-other-pane'],
      'pane.transcript',
      expect.any(String),
    )
    expect(ensureCaps).toHaveBeenCalledWith(
      {},
      caller,
      ['read-other-pane', 'all-workspaces'],
      'pane.transcript',
      expect.any(String),
    )
  })

  it('refuses a sandboxed caller outright, even for a confined pane of its own workspace', async () => {
    sandboxed.add('ws1')
    confined.add(worker.paneId)
    await expect(ask(caller, { pane: worker.externalId })).rejects.toThrow('sandboxed')
    expect(lines).not.toHaveBeenCalled()
  })

  it('hides the manager pane and an unknown pane', async () => {
    const manager = registerPane({ windowId: 'w1', workspaceId: 'mgr', paneId: 'tr-manager' })
    markManager('tr-manager')
    await expect(ask(caller, { pane: manager.externalId })).rejects.toThrow('unknown-pane')
    await expect(ask(caller, { pane: 'nope' })).rejects.toThrow('unknown-pane')
    await expect(ask(caller, {})).rejects.toThrow('bad-request: pane')
  })
})
