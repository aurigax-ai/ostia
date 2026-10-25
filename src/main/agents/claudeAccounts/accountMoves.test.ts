import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentBusyReason } from '../../../shared/agents/agentWork'
import { AccountMoves, type MovePane } from './accountMoves'

const WORK = 'a'.repeat(16)

let current: string
let accountOf: Map<string, string>
let panes: MovePane[]
let isolated: Set<string>
let turns: Map<string, string>
let busy: Map<string, AgentBusyReason>
let drafts: Set<string>
let inputs: Map<string, number>
let hibernateOutcome: (paneId: string) => string
let wakeResult: boolean
let steps: string[]
let moves: AccountMoves

const claudePane = (paneId: string, extra: Partial<MovePane> = {}): MovePane => ({
  paneId,
  agent: 'claude',
  session: `session-${paneId}`,
  hibernated: false,
  waking: false,
  ...extra,
})

beforeEach(() => {
  current = WORK
  accountOf = new Map([['p1', 'default']])
  panes = [claudePane('p1')]
  isolated = new Set()
  turns = new Map()
  busy = new Map()
  drafts = new Set()
  inputs = new Map([['p1', 0]])
  hibernateOutcome = () => 'hibernated'
  wakeResult = true
  steps = []
  moves = new AccountMoves({
    current: () => current,
    accountOf: (paneId) => accountOf.get(paneId),
    panes: async () => panes,
    isolated: (paneId) => isolated.has(paneId),
    turnState: (paneId) => turns.get(paneId),
    busy: async (paneId) => busy.get(paneId) ?? null,
    drafting: (paneId) => drafts.has(paneId),
    inputCount: (paneId) => inputs.get(paneId),
    hibernate: async (paneId) => {
      steps.push(`hibernate ${paneId}`)
      const outcome = hibernateOutcome(paneId)
      if (outcome === 'hibernated') {
        panes = panes.map((p) => (p.paneId === paneId ? { ...p, hibernated: true } : p))
      }
      return outcome
    },
    wake: async (paneId) => {
      steps.push(`wake ${paneId}`)
      return wakeResult
    },
    waking: {
      start: (paneId) => steps.push(`waking ${paneId}`),
      abandon: (paneId) => steps.push(`abandon ${paneId}`),
    },
    stays: (paneId) => steps.push(`stays ${paneId}`),
  })
})

describe('a switch', () => {
  it('CLA-M1 hibernates an idle Claude pane on another account, then wakes it so it resumes there', async () => {
    await moves.switched()
    expect(steps).toEqual(['hibernate p1', 'waking p1', 'wake p1'])
  })

  it('leaves a pane already on the current account, a hibernated one and a pane with no Claude', async () => {
    accountOf = new Map([
      ['p1', WORK],
      ['p2', 'default'],
      ['p3', 'default'],
    ])
    panes = [
      claudePane('p1'),
      claudePane('p2', { hibernated: true }),
      { paneId: 'p3', agent: 'codex', hibernated: false, waking: false },
    ]
    await moves.switched()
    expect(steps).toEqual([])
  })

  it('never moves a manager, sandboxed or scratch pane, or one whose account Ostia never chose', async () => {
    panes = [claudePane('p1'), claudePane('p2')]
    isolated.add('p1')
    await moves.switched()
    expect(steps).toEqual([])
  })

  it('tells the human in the pane when it has no session to resume, and leaves it running', async () => {
    panes = [claudePane('p1', { session: undefined })]
    await moves.switched()
    expect(steps).toEqual(['stays p1'])
    await moves.idle('p1')
    expect(steps).toEqual(['stays p1'])
  })

  it('moves every owed pane once when two switches overlap', async () => {
    accountOf.set('p2', 'default')
    panes = [claudePane('p1'), claudePane('p2')]
    await Promise.all([moves.switched(), moves.switched()])
    expect(steps.filter((s) => s.startsWith('hibernate')).sort()).toEqual([
      'hibernate p1',
      'hibernate p2',
    ])
  })
})

describe('a pane that is not idle at the switch', () => {
  it.each([
    ['working', 'working'],
    ['waiting', 'waiting'],
  ])('CLA-M2 is not stopped while %s, and moves when its turn ends', async (_name, state) => {
    turns.set('p1', state)
    await moves.switched()
    expect(steps).toEqual([])
    turns.set('p1', 'done')
    await moves.idle('p1')
    expect(steps).toEqual(['hibernate p1', 'waking p1', 'wake p1'])
  })

  it('waits for background work to end', async () => {
    busy.set('p1', 'subagent')
    await moves.switched()
    expect(steps).toEqual([])
    busy.delete('p1')
    await moves.idle('p1')
    expect(steps).toEqual(['hibernate p1', 'waking p1', 'wake p1'])
  })

  it('waits while the human has a draft in the prompt', async () => {
    drafts.add('p1')
    await moves.switched()
    expect(steps).toEqual([])
    drafts.delete('p1')
    await moves.idle('p1')
    expect(steps).toEqual(['hibernate p1', 'waking p1', 'wake p1'])
  })

  it('waits while another wake of the pane is in flight', async () => {
    panes = [claudePane('p1', { waking: true })]
    await moves.switched()
    expect(steps).toEqual([])
  })

  it('stays owed when main refuses the hibernation for work it found, and tries again later', async () => {
    hibernateOutcome = () => 'child-process'
    await moves.switched()
    expect(steps).toEqual(['hibernate p1'])
    hibernateOutcome = () => 'hibernated'
    await moves.idle('p1')
    expect(steps).toEqual(['hibernate p1', 'hibernate p1', 'waking p1', 'wake p1'])
  })

  it('is not moved when the human switches back to its account first', async () => {
    turns.set('p1', 'working')
    await moves.switched()
    current = 'default'
    turns.set('p1', 'done')
    await moves.idle('p1')
    expect(steps).toEqual([])
  })

  it('is forgotten when its Claude exits, so a later turn of a new Claude does not move it', async () => {
    turns.set('p1', 'working')
    await moves.switched()
    panes = [{ paneId: 'p1', hibernated: false, waking: false }]
    await moves.idle('p1')
    panes = [claudePane('p1')]
    turns.set('p1', 'done')
    await moves.idle('p1')
    expect(steps).toEqual([])
  })

  it('does nothing for a pane no switch made owed', async () => {
    await moves.idle('p1')
    expect(steps).toEqual([])
  })
})

describe('races during the move', () => {
  it('CLA-M3 holds the hibernation when input reached the pane or a turn began after the move decided', async () => {
    let held: boolean[] = []
    hibernateOutcome = (paneId) => {
      held = [moves.holds(paneId, 0)]
      inputs.set(paneId, 1)
      held.push(moves.holds(paneId, 1), moves.holds(paneId, 0))
      inputs.set(paneId, 0)
      turns.set(paneId, 'working')
      held.push(moves.holds(paneId, 0))
      return 'typed'
    }
    await moves.switched()
    expect(held).toEqual([false, true, false, true])
    expect(steps).toEqual(['hibernate p1'])
    expect(moves.holds('p1', 5)).toBe(false)
  })

  it('tries again after a held hibernation once the turn ends', async () => {
    hibernateOutcome = () => 'typed'
    await moves.switched()
    hibernateOutcome = () => 'hibernated'
    await moves.idle('p1')
    expect(steps).toEqual(['hibernate p1', 'hibernate p1', 'waking p1', 'wake p1'])
  })

  it('stops when the pane closed before main hibernated it, and wakes nothing', async () => {
    hibernateOutcome = () => 'no-terminal'
    await moves.switched()
    await moves.idle('p1')
    expect(steps).toEqual(['hibernate p1'])
  })

  it('forgets a pane closed while it was owed', async () => {
    turns.set('p1', 'working')
    await moves.switched()
    moves.closed('p1')
    turns.set('p1', 'done')
    await moves.idle('p1')
    expect(steps).toEqual([])
  })

  it('ends the wake it began when the pane cannot be woken', async () => {
    wakeResult = false
    await moves.switched()
    expect(steps).toEqual(['hibernate p1', 'waking p1', 'wake p1', 'abandon p1'])
  })
})
