import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReferenceInsert, WindowWorkspaceReport } from '../../shared/types'
import {
  type OriginRules,
  REFERENCE_NOTE_MAX,
  REFERENCE_TEXT_MAX,
  ReferenceRelay,
  originAgentOwner,
  originAgents,
  parseReferenceRequest,
  reachesTarget,
  summaryOf,
  workspaceOfPane,
} from './originAgents'

const MAIN = 'win-main'
const DETACHED = 'win-detached'
const OTHER = 'win-other'

function workspace(over: Partial<WindowWorkspaceReport> & { id: string }): WindowWorkspaceReport {
  return { name: over.id, workDir: '/home/u/api', state: 'idle', unreadAt: 0, panes: [], ...over }
}

const home = workspace({
  id: 'w-home',
  name: 'api',
  panes: [
    { id: 'agent-1', title: 'fix login', agent: 'claude', state: 'waiting', cwd: '/home/u/api' },
    { id: 'shell-1', title: 'zsh' },
    { id: 'manager-1', title: 'manager', agent: 'other', state: 'working' },
  ],
})

const elsewhere = workspace({
  id: 'w-elsewhere',
  panes: [{ id: 'agent-2', title: 'codex', agent: 'codex', state: 'working' }],
})

const moved = workspace({
  id: 'w-moved',
  origin: 'w-home',
  panes: [{ id: 'browser-1', title: 'localhost' }],
})

function reports(
  over: Record<string, WindowWorkspaceReport[]> = {},
): Map<string, WindowWorkspaceReport[]> {
  return new Map(Object.entries({ [MAIN]: [home, elsewhere], [DETACHED]: [moved], ...over }))
}

const OWNERS: Record<string, string> = {
  'agent-1': MAIN,
  'shell-1': MAIN,
  'manager-1': MAIN,
  'agent-2': MAIN,
  'browser-1': DETACHED,
}

function rules(over: Partial<OriginRules> = {}): OriginRules {
  return {
    isSandboxed: () => false,
    isScratch: () => false,
    isManagerPane: (paneId) => paneId === 'manager-1',
    ownerOfPane: (paneId) => OWNERS[paneId],
    ...over,
  }
}

describe('originAgents', () => {
  it('lists only the agent panes of the workspace the caller’s workspace came from', () => {
    expect(originAgents(reports(), rules(), DETACHED, 'w-moved')).toEqual({
      workspaceId: 'w-home',
      workspaceName: 'api',
      targets: [
        {
          paneId: 'agent-1',
          title: 'fix login',
          agent: 'claude',
          state: 'waiting',
          cwd: '/home/u/api',
        },
      ],
    })
  })

  it('answers nothing for a workspace the caller’s window does not hold', () => {
    expect(originAgents(reports(), rules(), OTHER, 'w-moved')).toBeNull()
    expect(originAgents(reports(), rules(), MAIN, 'w-moved')).toBeNull()
    expect(originAgents(reports(), rules(), DETACHED, 'w-home')).toBeNull()
  })

  it('answers nothing for a workspace without an origin or whose origin is itself', () => {
    const whole = workspace({ id: 'w-whole', origin: 'w-whole' })
    const all = reports({ [DETACHED]: [whole, workspace({ id: 'w-plain' })] })

    expect(originAgents(all, rules(), DETACHED, 'w-whole')).toBeNull()
    expect(originAgents(all, rules(), DETACHED, 'w-plain')).toBeNull()
    expect(originAgents(all, rules(), DETACHED, 42)).toBeNull()
  })

  it('answers nothing once the origin workspace is closed', () => {
    expect(originAgents(reports({ [MAIN]: [elsewhere] }), rules(), DETACHED, 'w-moved')).toBeNull()
  })

  it('answers nothing when either side is sandboxed or scratch', () => {
    const all = reports()

    for (const id of ['w-home', 'w-moved']) {
      expect(
        originAgents(all, rules({ isSandboxed: (w) => w === id }), DETACHED, 'w-moved'),
      ).toBeNull()
      expect(
        originAgents(all, rules({ isScratch: (w) => w === id }), DETACHED, 'w-moved'),
      ).toBeNull()
    }
  })

  it('finds the origin workspace in whichever other window holds it', () => {
    const all = reports({ [MAIN]: [elsewhere], [OTHER]: [home] })
    const owners = rules({ ownerOfPane: (paneId) => (paneId === 'agent-1' ? OTHER : MAIN) })

    expect(originAgents(all, owners, DETACHED, 'w-moved')?.targets.map((t) => t.paneId)).toEqual([
      'agent-1',
    ])
    expect(originAgentOwner(all, owners, DETACHED, 'w-moved', 'agent-1')).toBe(OTHER)
  })

  it('drops a pane the reporting window does not own', () => {
    const forged = rules({ ownerOfPane: (paneId) => (paneId === 'agent-1' ? OTHER : MAIN) })

    expect(originAgents(reports(), forged, DETACHED, 'w-moved')?.targets).toEqual([])
  })
})

describe('originAgentOwner', () => {
  it('names the window that owns an agent pane of the origin workspace', () => {
    expect(originAgentOwner(reports(), rules(), DETACHED, 'w-moved', 'agent-1')).toBe(MAIN)
  })

  it('refuses a plain shell, the manager pane and a pane of another workspace', () => {
    for (const paneId of ['shell-1', 'manager-1', 'agent-2', 'ghost']) {
      expect(originAgentOwner(reports(), rules(), DETACHED, 'w-moved', paneId)).toBeNull()
    }
  })

  it('refuses a sender that does not hold the workspace it names', () => {
    expect(originAgentOwner(reports(), rules(), OTHER, 'w-moved', 'agent-1')).toBeNull()
    expect(originAgentOwner(reports(), rules(), DETACHED, 'w-elsewhere', 'agent-2')).toBeNull()
  })
})

describe('reachesTarget', () => {
  it('reaches a pane of the sender’s own window', () => {
    expect(reachesTarget(reports(), rules(), MAIN, 'shell-1', 'agent-2')).toBe(true)
  })

  it('reaches an agent of the origin workspace from a pane that left it', () => {
    expect(reachesTarget(reports(), rules(), DETACHED, 'browser-1', 'agent-1')).toBe(true)
  })

  it('refuses another window’s pane outside the origin workspace, and plain shells in it', () => {
    expect(reachesTarget(reports(), rules(), DETACHED, 'browser-1', 'agent-2')).toBe(false)
    expect(reachesTarget(reports(), rules(), DETACHED, 'browser-1', 'shell-1')).toBe(false)
  })

  it('refuses a source pane the sender does not own or has not reported', () => {
    expect(reachesTarget(reports(), rules(), OTHER, 'browser-1', 'agent-1')).toBe(false)
    expect(
      reachesTarget(reports({ [DETACHED]: [] }), rules(), DETACHED, 'browser-1', 'agent-1'),
    ).toBe(false)
    expect(workspaceOfPane(reports(), MAIN, 'browser-1')).toBeNull()
  })

  it('refuses the origin’s agents to a sandboxed sender', () => {
    const sandboxed = rules({ isSandboxed: (w) => w === 'w-moved' })

    expect(reachesTarget(reports(), sandboxed, DETACHED, 'browser-1', 'agent-1')).toBe(false)
  })
})

describe('summaryOf', () => {
  it('keeps agents, states, folders and the origin out of the list every window gets', () => {
    expect(summaryOf({ ...home, origin: 'w-x' })).toEqual({
      id: 'w-home',
      name: 'api',
      workDir: '/home/u/api',
      state: 'idle',
      unreadAt: 0,
      panes: [
        { id: 'agent-1', title: 'fix login' },
        { id: 'shell-1', title: 'zsh' },
        { id: 'manager-1', title: 'manager' },
      ],
    })
  })
})

describe('parseReferenceRequest', () => {
  it('keeps the workspace, pane and text, and clips the note to one short line', () => {
    const note = `  look\n at   this ${'x'.repeat(200)}`

    const parsed = parseReferenceRequest({
      workspaceId: 'w-moved',
      paneId: 'agent-1',
      text: '@/tmp/ostia-reports-1/capture-1.md ',
      note,
      extra: true,
    })

    expect(parsed?.note).toHaveLength(REFERENCE_NOTE_MAX)
    expect(parsed?.note?.startsWith('look at this x')).toBe(true)
    expect(parsed).toEqual({
      workspaceId: 'w-moved',
      paneId: 'agent-1',
      text: '@/tmp/ostia-reports-1/capture-1.md ',
      note: parsed?.note,
    })
  })

  it('refuses a request without ids or text, or with text past the cap', () => {
    const base = { workspaceId: 'w-moved', paneId: 'agent-1', text: 'hi' }

    expect(parseReferenceRequest(null)).toBeNull()
    expect(parseReferenceRequest({ ...base, workspaceId: '' })).toBeNull()
    expect(parseReferenceRequest({ ...base, paneId: 7 })).toBeNull()
    expect(parseReferenceRequest({ ...base, text: '' })).toBeNull()
    expect(parseReferenceRequest({ ...base, text: 'x'.repeat(REFERENCE_TEXT_MAX + 1) })).toBeNull()
    expect(parseReferenceRequest(base)).toEqual(base)
  })

  it('keeps pointedByHuman only when it is exactly true', () => {
    const base = { workspaceId: 'w-moved', paneId: 'agent-1', text: 'hi' }

    expect(parseReferenceRequest({ ...base, pointedByHuman: true })).toEqual({
      ...base,
      pointedByHuman: true,
    })
    expect(parseReferenceRequest({ ...base, pointedByHuman: 'yes' })).toEqual(base)
    expect(parseReferenceRequest({ ...base, pointedByHuman: false })).toEqual(base)
  })
})

describe('ReferenceRelay', () => {
  const request = { workspaceId: 'w-moved', paneId: 'agent-1', text: '@/tmp/r.md ', note: 'look' }
  let sent: { windowId: string; insert: ReferenceInsert }[]
  let relay: ReferenceRelay

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    relay = new ReferenceRelay((windowId, insert) => {
      sent.push({ windowId, insert })
      return true
    }, 1000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the insert only to the owning window and resolves with its answer', async () => {
    const result = relay.forward(MAIN, request)

    expect(sent).toHaveLength(1)
    expect(sent[0].windowId).toBe(MAIN)
    expect(sent[0].insert).toMatchObject({ paneId: 'agent-1', text: '@/tmp/r.md ', note: 'look' })
    expect(sent[0].insert).not.toHaveProperty('workspaceId')
    relay.answer(MAIN, sent[0].insert.requestId, true)

    await expect(result).resolves.toBe(true)
  })

  it('carries pointedByHuman to the owning window as data, never a key', () => {
    void relay.forward(MAIN, { ...request, pointedByHuman: true })
    void relay.forward(MAIN, request)

    expect(sent[0].insert).toMatchObject({ text: '@/tmp/r.md ', pointedByHuman: true })
    expect(sent[1].insert).not.toHaveProperty('pointedByHuman')
  })

  it('ignores an answer from a window that was not asked', async () => {
    const result = relay.forward(MAIN, request)

    relay.answer(DETACHED, sent[0].insert.requestId, true)
    relay.answer(MAIN, 'reference-nope', true)
    relay.answer(MAIN, sent[0].insert.requestId, false)

    await expect(result).resolves.toBe(false)
  })

  it('answers not inserted when the owner never replies, is gone or closes', async () => {
    const silent = relay.forward(MAIN, request)
    vi.advanceTimersByTime(1000)
    await expect(silent).resolves.toBe(false)

    const closing = relay.forward(MAIN, request)
    relay.windowClosed(MAIN)
    await expect(closing).resolves.toBe(false)

    const gone = new ReferenceRelay(() => false, 1000)
    await expect(gone.forward(MAIN, request)).resolves.toBe(false)
  })

  it('takes only the first answer to a request', async () => {
    const result = relay.forward(MAIN, request)
    const { requestId } = sent[0].insert

    relay.answer(MAIN, requestId, false)
    relay.answer(MAIN, requestId, true)

    await expect(result).resolves.toBe(false)
  })
})
