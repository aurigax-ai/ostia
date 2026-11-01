import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentBusyReason } from '../../shared/agents/agentWork'
import { registerPane, removePane } from '../control/idRegistry'
import { finishedOf, PaneLifecycle } from './paneLifecycle'
import type { PaneEntry } from './paneList'
import { ProcessRegistry } from './processRegistry'

const MINUTE = 60_000
const ROW = { pid: 100, ppid: 1, state: 'S+', tty: 'pts/1' }

function entry(paneId: string, over: Partial<PaneEntry> = {}): PaneEntry {
  return {
    paneId,
    workspaceId: 'ws',
    kind: 'terminal',
    title: paneId,
    running: true,
    blockCount: 0,
    agent: 'claude',
    agentState: 'working',
    pid: 100,
    ...over,
  }
}

let clock = 0
let busy: AgentBusyReason | null = null
let drafting = false
let owners = new Map<string, string>()
let posted: { from: string; to: string; text: string }[] = []
let hibernated: string[] = []
let minutes = 10
const closing = new Map<string, string>()

const lifecycle = () =>
  new PaneLifecycle({
    rows: async () => [ROW],
    reported: () => busy,
    drafting: () => drafting,
    ownerOf: (paneId) => owners.get(paneId),
    nameOf: () => undefined,
    closing: (paneId) => closing.get(paneId),
    post: (from, to, text) => posted.push({ from, to, text }),
    hibernate: async (to) => hibernated.push(to.paneId),
    hibernateMinutes: () => minutes,
    now: () => clock,
  })

let owner = registerPane({ windowId: 'w', workspaceId: 'ws', paneId: 'owner' })
let child = registerPane({ windowId: 'w', workspaceId: 'ws', paneId: 'child' })

beforeEach(() => {
  removePane('owner')
  removePane('child')
  owner = registerPane({ windowId: 'w', workspaceId: 'ws', paneId: 'owner' })
  child = registerPane({ windowId: 'w', workspaceId: 'ws', paneId: 'child' })
  clock = 1_000
  busy = null
  drafting = false
  owners = new Map([['child', 'owner']])
  posted = []
  hibernated = []
  minutes = 10
  closing.clear()
})

describe('finishedOf', () => {
  it('WLC-C2 is finished only after the turn ended with nothing running and nothing typed', () => {
    expect(finishedOf(entry('c', { agentState: 'working' }), null, false)).toBe(false)
    expect(finishedOf(entry('c', { agentState: 'done' }), null, false)).toBe(true)
    expect(finishedOf(entry('c', { agentState: 'done' }), null, true)).toBe(false)
  })

  it('WLC-C3 background work keeps it unfinished', () => {
    expect(finishedOf(entry('c', { agentState: 'done' }), 'background-task', false)).toBe(false)
    expect(finishedOf(entry('c', { agentState: 'done' }), 'child-process', false)).toBe(false)
  })

  it('WLC-C4 waiting on the human is not finished', () => {
    expect(finishedOf(entry('c', { agentState: 'waiting' }), null, false)).toBe(false)
  })
})

describe('PaneLifecycle', () => {
  it('WLC-C9 a fresh registry holds no owners, so after a restart nothing is owned and no event is sent', async () => {
    const registry = new ProcessRegistry({
      ring: () => undefined,
      workspaceOfPane: () => undefined,
      now: () => new Date(0),
    })
    expect(registry.ownerOf('child')).toBeUndefined()
    owners = new Map()
    const life = lifecycle()
    const facts = await life.evaluate([entry(child.externalId, { agentState: 'done' })])
    expect(facts.get(child.externalId)).toMatchObject({ finished: true })
    expect(facts.get(child.externalId)?.owner).toBeUndefined()
    expect(posted).toEqual([])
    expect(await life.hibernateDue([entry(child.externalId, { agentState: 'done' })])).toEqual([])
  })

  it('WLC-C10 hibernates an owned finished worker after the configured minutes, never a kept-awake one', async () => {
    const life = lifecycle()
    const done = entry(child.externalId, { agentState: 'done' })
    expect(await life.hibernateDue([done])).toEqual([])
    clock += 9 * MINUTE
    expect(await life.hibernateDue([done])).toEqual([])
    clock += 2 * MINUTE
    expect(await life.hibernateDue([{ ...done, keepAwake: true }])).toEqual([])
    expect(hibernated).toEqual([])
    expect(await life.hibernateDue([done])).toEqual([done.paneId])
    expect(hibernated).toEqual(['child'])
  })

  it('WLC-C10 does not hibernate when work appears, or when the setting is 0', async () => {
    const life = lifecycle()
    const done = entry(child.externalId, { agentState: 'done' })
    await life.hibernateDue([done])
    clock += 11 * MINUTE
    busy = 'background-task'
    expect(await life.hibernateDue([done])).toEqual([])
    busy = null
    minutes = 0
    clock += 11 * MINUTE
    expect(await life.hibernateDue([done])).toEqual([])
    expect(hibernated).toEqual([])
  })

  it('WLC-C11 sends the owner exactly one event when a worker becomes finished, and one more after it worked again', async () => {
    const life = lifecycle()
    closing.set('child', 'all green')
    const working = entry(child.externalId, { agentState: 'working' })
    const done = { ...working, agentState: 'done' }
    await life.evaluate([working])
    expect(posted).toEqual([])
    await life.evaluate([done])
    await life.evaluate([done])
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ from: child.externalId, to: owner.externalId })
    expect(posted[0].text).toContain('finished')
    expect(posted[0].text).toContain('all green')
    await life.evaluate([working])
    await life.evaluate([done])
    expect(posted).toHaveLength(2)
  })

  it('WLC-C11 sends no event for a finished pane that has no owner', async () => {
    owners = new Map()
    const life = lifecycle()
    await life.evaluate([entry(child.externalId, { agentState: 'done' })])
    expect(posted).toEqual([])
  })
})

describe('ProcessRegistry ownership', () => {
  const make = () =>
    new ProcessRegistry({
      ring: () => undefined,
      workspaceOfPane: () => undefined,
      now: () => new Date(0),
    })

  it('WLC-C8 drops the owner when either pane closes', () => {
    const registry = make()
    registry.adoptChild('a', 'b')
    registry.adoptChild('a', 'c')
    expect(registry.ownerOf('b')).toBe('a')
    expect(registry.childrenOf('a')).toEqual(['b', 'c'])
    registry.paneClosed('b')
    expect(registry.childrenOf('a')).toEqual(['c'])
    registry.paneClosed('a')
    expect(registry.ownerOf('c')).toBeUndefined()
  })
})
