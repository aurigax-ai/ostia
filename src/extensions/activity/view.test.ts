import { describe, expect, it } from 'vitest'
import type { ActivityEvent } from './hookEvent'
import { EARLIER_TURNS_MAX, ageOf, panelModel, turnsOf } from './view'

let clock = 0

function ev(
  pane: string,
  kind: ActivityEvent['kind'],
  text?: string,
  extra: Partial<ActivityEvent> = {},
): ActivityEvent {
  clock += 10
  const event: ActivityEvent = {
    v: 1,
    t: clock,
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
    workspaces: [
      { workspaceId: 'w1', name: 'shop' },
      { workspaceId: 'w2', name: 'site' },
      { workspaceId: 'empty', name: 'empty' },
    ],
    panes: [
      { paneId: 'claude-pane', agentState: 'working' },
      { paneId: 'codex-pane', agentState: 'bogus' },
      { paneId: 'other-pane' },
      { paneId: 'idle-pane', agentState: 'done' },
    ],
    events: (id: string) => journals[id] ?? [],
  }

  it('groups agents by open workspace, most recent first, with state, latest recap and turns', () => {
    const model = panelModel(sources)
    expect(model.showActivity).toBe(true)
    expect(model.workspaces.map((w) => [w.name, w.agents.map((a) => a.paneId)])).toEqual([
      ['site', ['other-pane']],
      ['shop', ['claude-pane', 'codex-pane']],
    ])
    const claude = model.workspaces[1].agents[0]
    expect(claude).toMatchObject({ agent: 'claude', state: 'working', recap: 'Cart fixed.' })
    expect(claude.current.prompt).toBe('now the footer')
    expect(claude.current.recap).toBeUndefined()
    expect(claude.earlier.map((t) => [t.prompt, t.recap])).toEqual([
      ['fix the cart', 'Cart fixed.'],
    ])
    expect(claude.last).toBe(journals.w1[4].t)
  })

  it('invents nothing: no recap before a stop, no state Ostia did not report, no row without events', () => {
    const model = panelModel(sources)
    const codex = model.workspaces[1].agents[1]
    expect(codex.agent).toBe('codex')
    expect('recap' in codex).toBe(false)
    expect('state' in codex).toBe(false)
    expect(codex.earlier).toEqual([])
    const shown = model.workspaces.flatMap((w) => w.agents.map((a) => a.paneId))
    expect(shown).not.toContain('idle-pane')
    expect(shown).not.toContain('closed-pane')
    expect(shown).not.toContain('lost-pane')
    expect(model.workspaces.map((w) => w.workspaceId)).not.toContain('empty')
  })

  it('carries the toggle and caps the earlier turns it sends', () => {
    expect(panelModel({ ...sources, showActivity: false }).showActivity).toBe(false)
    const many = Array.from({ length: EARLIER_TURNS_MAX + 5 }, (_, i) => [
      ev('p', 'prompt', `turn ${i}`),
      ev('p', 'stop', `recap ${i}`),
    ]).flat()
    const agent = panelModel({
      showActivity: true,
      workspaces: [{ workspaceId: 'w', name: 'w' }],
      panes: [{ paneId: 'p' }],
      events: () => many,
    }).workspaces[0].agents[0]
    expect(agent.earlier).toHaveLength(EARLIER_TURNS_MAX)
    expect(agent.earlier[0].prompt).toBe(`turn ${EARLIER_TURNS_MAX + 3}`)
    expect(agent.recap).toBe(`recap ${EARLIER_TURNS_MAX + 4}`)
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
