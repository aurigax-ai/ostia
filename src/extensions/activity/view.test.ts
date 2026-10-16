import { describe, expect, it } from 'vitest'
import type { ActivityEvent, ActivityHost, ActivityNote } from './hookEvent'
import { EARLIER_TURNS_MAX, actionCategory, actionCounts, ageOf, panelModel, turnsOf } from './view'

let clock = 0

function ev(
  pane: string,
  kind: ActivityEvent['kind'],
  text?: string,
  extra: Partial<ActivityEvent> = {},
): ActivityEvent {
  clock += 10
  const event: ActivityEvent = {
    v: 2,
    t: clock,
    id: 'eventidaaa',
    pane,
    agent: 'claude',
    session: 's',
    kind,
    ...extra,
  }
  if (kind === 'tool' && !event.tool) event.tool = 'command'
  if (text) event.text = text
  return event
}

describe('turnsOf', () => {
  it('starts a turn at each prompt, closes it at the stop and keeps the recap with its turn', () => {
    const turns = turnsOf([
      ev('p', 'prompt', 'fix the cart'),
      ev('p', 'tool', 'pnpm test'),
      ev('p', 'stop', 'Cart fixed.'),
      ev('p', 'prompt', 'now the footer'),
      ev('p', 'tool', 'footer.tsx', { tool: 'edit' }),
    ])
    expect(turns.map((t) => [t.prompt, t.recap, t.events.map((e) => e.kind)])).toEqual([
      ['fix the cart', 'Cart fixed.', ['prompt', 'tool', 'stop']],
      ['now the footer', undefined, ['prompt', 'tool']],
    ])
    expect(turns[1].events[1]).toMatchObject({ kind: 'tool', tool: 'edit', text: 'footer.tsx' })
  })

  it('groups events that came without a prompt into their own turn', () => {
    const turns = turnsOf([
      ev('p', 'tool', 'ls'),
      ev('p', 'stop'),
      ev('p', 'tool', 'pwd'),
      ev('p', 'stop', 'Done.'),
    ])
    expect(turns.map((t) => [t.prompt, t.recap, t.events.length])).toEqual([
      [undefined, undefined, 2],
      [undefined, 'Done.', 2],
    ])
  })
})

describe('panelModel', () => {
  const journals: Record<string, ActivityEvent[]> = {
    w1: [
      ev('claude-pane', 'prompt', 'fix the cart'),
      ev('claude-pane', 'tool', 'pnpm test'),
      ev('claude-pane', 'stop', 'Cart fixed.'),
      ev('codex-pane', 'prompt', 'write docs', { agent: 'codex' }),
      ev('claude-pane', 'prompt', 'now the footer'),
      ev('closed-pane', 'prompt', 'old work'),
    ],
    w2: [ev('other-pane', 'prompt', 'review')],
    closed: [ev('lost-pane', 'prompt', 'gone')],
  }
  const sources = {
    showActivity: true,
    workspace: { workspaceId: 'w1', name: 'shop' },
    panes: [
      { paneId: 'claude-pane', agentState: 'working' },
      { paneId: 'codex-pane', agentState: 'bogus' },
      { paneId: 'other-pane' },
      { paneId: 'idle-pane', agentState: 'done' },
    ],
    events: (id: string) => journals[id] ?? [],
  }

  it('shows the agents of the one workspace it is given, most recent first, with state, latest recap and turns', () => {
    const model = panelModel(sources)
    expect(model.showActivity).toBe(true)
    expect(model.workspace?.agents.map((a) => a.paneId)).toEqual(['claude-pane', 'codex-pane'])
    const claude = model.workspace?.agents[0]
    expect(claude).toMatchObject({ agent: 'claude', state: 'working', recap: 'Cart fixed.' })
    expect(claude?.current.prompt).toBe('now the footer')
    expect(claude?.current.recap).toBeUndefined()
    expect(claude?.earlier.map((t) => [t.prompt, t.recap])).toEqual([
      ['fix the cart', 'Cart fixed.'],
    ])
    expect(claude?.last).toBe(journals.w1[4].t)
  })

  it('never shows another workspace, and nothing for one without events or one that is not open', () => {
    const other = panelModel({ ...sources, workspace: { workspaceId: 'w2', name: 'site' } })
    expect(other.workspace?.agents.map((a) => a.paneId)).toEqual(['other-pane'])
    expect(JSON.stringify(other)).not.toContain('claude-pane')
    expect(
      panelModel({ ...sources, workspace: { workspaceId: 'empty', name: 'e' } }).workspace,
    ).toBeNull()
    expect(panelModel({ ...sources, workspace: undefined }).workspace).toBeNull()
  })

  it('invents nothing: no recap before a stop, no state Ostia did not report, no row without events', () => {
    const model = panelModel(sources)
    const codex = model.workspace?.agents[1]
    expect(codex?.agent).toBe('codex')
    expect(codex && 'recap' in codex).toBe(false)
    expect(codex && 'state' in codex).toBe(false)
    expect(codex?.earlier).toEqual([])
    const shown = model.workspace?.agents.map((a) => a.paneId) ?? []
    expect(shown).not.toContain('idle-pane')
    expect(shown).not.toContain('closed-pane')
  })

  it('carries the toggle and caps the earlier turns it sends', () => {
    expect(panelModel({ ...sources, showActivity: false }).showActivity).toBe(false)
    const many = Array.from({ length: EARLIER_TURNS_MAX + 5 }, (_, i) => [
      ev('p', 'prompt', `turn ${i}`),
      ev('p', 'stop', `recap ${i}`),
    ]).flat()
    const agent = panelModel({
      showActivity: true,
      workspace: { workspaceId: 'w', name: 'w' },
      panes: [{ paneId: 'p' }],
      events: () => many,
    }).workspace?.agents[0]
    expect(agent?.earlier).toHaveLength(EARLIER_TURNS_MAX)
    expect(agent?.earlier[0].prompt).toBe(`turn ${EARLIER_TURNS_MAX + 3}`)
    expect(agent?.recap).toBe(`recap ${EARLIER_TURNS_MAX + 4}`)
  })
})

describe('the workspace stream', () => {
  const host = (pane: string, t: number, extra: Partial<ActivityHost> = {}): ActivityHost => ({
    v: 2,
    t,
    id: `host${t}`,
    pane,
    kind: 'host',
    host: 'started',
    ...extra,
  })
  const model = (records: (ActivityEvent | ActivityHost)[]) =>
    panelModel({
      showActivity: true,
      workspace: { workspaceId: 'w', name: 'w' },
      panes: [],
      events: () => records,
    }).workspace

  it('lists host events newest first, labelled by agent and by order among panes of the same kind', () => {
    const rows = model([
      host('a', 1),
      host('b', 2),
      ev('a', 'prompt', 'go'),
      host('a', 3, { host: 'state', state: 'working' }),
    ])?.stream
    expect(rows?.map((r) => [r.host, r.subject])).toEqual([
      ['state', { agent: 'claude', n: 1 }],
      ['started', { n: 1 }],
      ['started', { agent: 'claude', n: 1 }],
    ])
  })

  it('shows a workspace that has only host events, and folds one bus message to its latest phase', () => {
    const workspace = model([
      host('a', 1, {
        host: 'bus',
        from: 'a',
        to: '@elsewhere',
        message: 'task',
        state: 'queued',
        ref: 'm1',
      }),
      host('a', 2, {
        host: 'bus',
        from: 'a',
        to: '@elsewhere',
        message: 'task',
        state: 'seen',
        ref: 'm1',
      }),
      host('a', 3, {
        host: 'bus',
        from: '@ostia',
        to: 'a',
        message: 'message',
        state: 'waiting',
        ref: 'm2',
      }),
    ])
    expect(workspace?.agents).toEqual([])
    expect(workspace?.stream.map((r) => [r.t, r.state, r.from?.kind, r.to?.kind])).toEqual([
      [3, 'waiting', 'ostia', 'pane'],
      [1, 'seen', 'pane', 'elsewhere'],
    ])
  })

  it('keeps host events out of the agents and their turns', () => {
    const prompt = ev('a', 'prompt', 'go')
    const agent = panelModel({
      showActivity: true,
      workspace: { workspaceId: 'w', name: 'w' },
      panes: [{ paneId: 'a' }],
      events: () => [prompt, host('a', prompt.t + 1000, { host: 'woken' })],
    }).workspace?.agents[0]
    expect(agent?.current.events.map((e) => e.kind)).toEqual(['prompt'])
    expect(agent?.last).toBe(prompt.t)
  })

  it('caps the rows it sends', () => {
    const many = Array.from({ length: 150 }, (_, i) => host('a', i + 1))
    expect(model(many)?.stream).toHaveLength(100)
  })
})

describe('actionCounts', () => {
  const tool = (kind: ActivityEvent['tool'], text?: string) =>
    turnsOf([ev('p', 'tool', text, { tool: kind })])[0].events[0]

  it('counts a turn’s tool actions by category in a fixed order and skips prompts and stops', () => {
    const turn = turnsOf([
      ev('p', 'prompt', 'go'),
      ev('p', 'tool', 'a', { tool: 'command' }),
      ev('p', 'tool', 'src/a.ts', { tool: 'edit' }),
      ev('p', 'tool', 'b', { tool: 'command' }),
      ev('p', 'tool', 'Skill', { tool: 'other' }),
      ev('p', 'tool', 'review', { tool: 'subagent' }),
      ev('p', 'tool', 'Skill', { tool: 'other' }),
      ev('p', 'tool', 'Mystery', { tool: 'other' }),
      ev('p', 'stop', 'done'),
    ])[0]
    expect(actionCounts(turn.events)).toEqual([
      { category: 'command', count: 2 },
      { category: 'edit', count: 1 },
      { category: 'subagent', count: 1 },
      { category: 'skill', count: 2 },
      { category: 'other', count: 1 },
    ])
  })

  it('has nothing to fold for a turn without tool actions', () => {
    expect(actionCounts(turnsOf([ev('p', 'prompt', 'hi'), ev('p', 'stop')])[0].events)).toEqual([])
  })

  it('names the category of one event', () => {
    expect(actionCategory(tool('web', 'https://x.dev'))).toBe('web')
    expect(actionCategory(tool('other', 'Skill'))).toBe('skill')
    expect(actionCategory(turnsOf([ev('p', 'prompt', 'x')])[0].events[0])).toBeNull()
  })
})

describe('panelModel notes', () => {
  const note = (t: number, id: string, extra: Partial<ActivityNote> = {}): ActivityNote => ({
    v: 2,
    t,
    id,
    pane: 'p1',
    kind: 'note',
    text: id,
    ...extra,
  })

  it('lists open needs-you items first, then the latest notes, and shows a workspace that has only notes', () => {
    const model = panelModel({
      showActivity: false,
      workspace: { workspaceId: 'w1', name: 'shop' },
      panes: [],
      events: () => [
        note(1, 'olderopenn', { needsYou: true }),
        note(2, 'plainnotea'),
        note(3, 'donedonedo', { needsYou: true, doneAt: 4 }),
        note(5, 'neweropenn', { needsYou: true, link: '/w/a.md' }),
      ],
    })
    expect(model.workspace?.agents).toEqual([])
    expect(model.workspace?.notes).toEqual([
      { id: 'neweropenn', t: 5, text: 'neweropenn', needsYou: true, done: false, link: '/w/a.md' },
      { id: 'olderopenn', t: 1, text: 'olderopenn', needsYou: true, done: false },
      { id: 'donedonedo', t: 3, text: 'donedonedo', needsYou: true, done: true },
      { id: 'plainnotea', t: 2, text: 'plainnotea', needsYou: false, done: false },
    ])
  })
})

describe('ageOf', () => {
  it('counts whole minutes, hours and days since the event', () => {
    const now = 10 * 24 * 60 * 60 * 1000
    expect(ageOf(now - 20_000, now)).toEqual({ unit: 'now', count: 0 })
    expect(ageOf(now + 5000, now)).toEqual({ unit: 'now', count: 0 })
    expect(ageOf(now - 5 * 60_000, now)).toEqual({ unit: 'minutes', count: 5 })
    expect(ageOf(now - 3 * 3_600_000, now)).toEqual({ unit: 'hours', count: 3 })
    expect(ageOf(now - 49 * 3_600_000, now)).toEqual({ unit: 'days', count: 2 })
  })
})
