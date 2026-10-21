import { describe, expect, it } from 'vitest'
import type { ActivityEvent, ActivityHost, ActivityNote } from './hookEvent'
import {
  actionCategory,
  actionCounts,
  agentLimitKey,
  ageOf,
  groupKey,
  limitsDigest,
  liveKeys,
  panelModel,
  STREAM_LIMIT_KEY,
  STREAM_PAGE,
  TURN_PAGE,
  turnsOf,
  widen,
} from './view'

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

  it('shows the agents of the one workspace it is given, in the order they first appeared, with state, latest recap and turns', () => {
    const model = panelModel(sources)
    expect(model.showActivity).toBe(true)
    expect(model.workspace?.agents.map((a) => a.paneId)).toEqual(['claude-pane', 'codex-pane'])
    const claude = model.workspace?.agents[0]
    expect(claude).toMatchObject({
      label: { agent: 'claude', n: 1 },
      state: 'working',
      recap: 'Cart fixed.',
    })
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
    expect(codex?.label.agent).toBe('codex')
    expect(codex && 'recap' in codex).toBe(false)
    expect(codex && 'state' in codex).toBe(false)
    expect(codex?.earlier).toEqual([])
    const shown = model.workspace?.agents.map((a) => a.paneId) ?? []
    expect(shown).not.toContain('idle-pane')
    expect(shown).not.toContain('closed-pane')
  })

  it('keeps the order of the agents when an older one gets a new event', () => {
    const records = [
      ev('first', 'prompt', 'a'),
      ev('second', 'prompt', 'b'),
      ev('third', 'prompt', 'c'),
    ]
    const order = (extra: ActivityEvent[]) =>
      panelModel({
        showActivity: true,
        workspace: { workspaceId: 'w', name: 'w' },
        panes: [{ paneId: 'first' }, { paneId: 'second' }, { paneId: 'third' }],
        events: () => [...records, ...extra],
      }).workspace?.agents.map((a) => a.paneId)
    expect(order([])).toEqual(['first', 'second', 'third'])
    expect(order([ev('first', 'tool', 'pnpm test')])).toEqual(['first', 'second', 'third'])
    expect(order([ev('second', 'tool', 'ls'), ev('first', 'tool', 'pwd')])).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  it('carries the toggle and sends only a page of earlier turns, newest first, counting the rest', () => {
    expect(panelModel({ ...sources, showActivity: false }).showActivity).toBe(false)
    const total = TURN_PAGE * 3 + 2
    const many = Array.from({ length: total }, (_, i) => [
      ev('p', 'prompt', `turn ${i}`),
      ev('p', 'stop', `recap ${i}`),
    ]).flat()
    const agentWith = (limits: Record<string, number>) =>
      panelModel({
        showActivity: true,
        workspace: { workspaceId: 'w', name: 'w' },
        panes: [{ paneId: 'p' }],
        limits,
        events: () => many,
      }).workspace?.agents[0]
    const first = agentWith({})
    expect(first?.earlier).toHaveLength(TURN_PAGE)
    expect(first?.earlier[0].prompt).toBe(`turn ${total - 2}`)
    expect(first?.more).toBe(total - 1 - TURN_PAGE)
    expect(first?.recap).toBe(`recap ${total - 1}`)
    const wider = agentWith({ [agentLimitKey('p')]: TURN_PAGE * 2 })
    expect(wider?.earlier).toHaveLength(TURN_PAGE * 2)
    expect(wider?.earlier.slice(0, TURN_PAGE)).toEqual(first?.earlier)
    expect(wider?.more).toBe(total - 1 - TURN_PAGE * 2)
    const all = agentWith({ [agentLimitKey('p')]: total * 2 })
    expect(all?.earlier).toHaveLength(total - 1)
    expect(all?.more).toBe(0)
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

  const more = (records: (ActivityEvent | ActivityHost)[]) =>
    panelModel({
      showActivity: true,
      workspace: { workspaceId: 'w', name: 'w' },
      panes: [],
      limits: { [STREAM_LIMIT_KEY]: 100 },
      events: () => records,
    }).workspace

  it('lists host events newest first, labelled by agent and by order among panes of the same kind', () => {
    const rows = model([
      host('a', 1),
      host('b', 60_000),
      ev('a', 'prompt', 'go'),
      host('a', 120_000, { host: 'state', state: 'working' }),
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
        state: 'failed',
        ref: 'm1',
      }),
      host('a', 3, {
        host: 'bus',
        from: '@ostia',
        to: 'a',
        message: 'message',
        state: 'delivered',
        ref: 'm2',
      }),
    ])
    expect(workspace?.agents).toEqual([])
    expect(workspace?.stream.map((r) => [r.t, r.state, r.from?.kind, r.to?.kind])).toEqual([
      [3, 'delivered', 'ostia', 'pane'],
      [1, 'failed', 'pane', 'elsewhere'],
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

  it('sends one page of rows, newest first, and more of them when the panel asks', () => {
    const spread = Array.from({ length: STREAM_PAGE * 3 }, (_, i) =>
      host('a', (i + 1) * 60_000, { host: i % 2 === 0 ? 'started' : 'closed' }),
    )
    const page = model(spread)
    expect(page?.stream).toHaveLength(STREAM_PAGE)
    expect(page?.stream[0].t).toBe(STREAM_PAGE * 3 * 60_000)
    expect(page?.streamMore).toBe(STREAM_PAGE * 2)
    const wider = panelModel({
      showActivity: true,
      workspace: { workspaceId: 'w', name: 'w' },
      panes: [],
      limits: { [STREAM_LIMIT_KEY]: STREAM_PAGE * 3 },
      events: () => spread,
    }).workspace
    expect(wider?.stream).toHaveLength(STREAM_PAGE * 3)
    expect(wider?.streamMore).toBe(0)
  })

  it('collapses hosts events of one kind that land in one short window into one row', () => {
    const moved = Array.from({ length: 12 }, (_, i) =>
      host(`p${i}`, 1000 + i * 100, { host: 'folder', folder: '…/r2' }),
    )
    const rows = model(moved)?.stream
    expect(rows).toHaveLength(1)
    expect(rows?.[0]).toMatchObject({ host: 'folder', folder: '…/r2', t: 2100 })
    expect(rows?.[0].panes).toHaveLength(12)
    expect(rows?.[0].id).toBe('host1000')
  })

  it('merges only a contiguous run, so the rows keep the order the events happened in', () => {
    const rows = more([
      host('a', 1000, { host: 'folder', folder: 'r2' }),
      host('a', 1100, { host: 'folder', folder: 'r3' }),
      host('b', 1200, { host: 'folder', folder: 'r2' }),
    ])?.stream
    expect(rows?.map((r) => [r.folder, r.t, r.panes?.length])).toEqual([
      ['r2', 1200, undefined],
      ['r3', 1100, undefined],
      ['r2', 1000, undefined],
    ])
  })

  it('keeps other kinds, other folders and a burst after the window as rows of their own', () => {
    const rows = more([
      host('a', 1000, { host: 'folder', folder: 'x' }),
      host('b', 1100, { host: 'folder', folder: 'x' }),
      host('c', 1200, { host: 'folder', folder: 'y' }),
      host('d', 1300, { host: 'state', state: 'working' }),
      host('e', 1400, { host: 'state', state: 'done' }),
      host('f', 60_000, { host: 'folder', folder: 'x' }),
      host('g', 60_100, { host: 'folder', folder: 'x' }),
    ])?.stream
    expect(rows?.map((r) => [r.host, r.folder ?? r.state, r.panes?.length])).toEqual([
      ['folder', 'x', 2],
      ['state', 'done', undefined],
      ['state', 'working', undefined],
      ['folder', 'y', undefined],
      ['folder', 'x', 2],
    ])
  })

  it('measures the window from the first event of the run, so a slow trickle is not one row for ever', () => {
    const rows = more([0, 1, 2, 3, 4].map((i) => host(`p${i}`, 1000 + i * 4000)))?.stream
    expect(rows?.map((r) => r.panes?.length)).toEqual([undefined, 2, 2])
  })

  it('lists every pane of a collapsed row in order, with the labels the rows use', () => {
    const rows = more([host('a', 1000), host('b', 1100), host('c', 1200)])?.stream
    expect(rows).toHaveLength(1)
    expect(rows?.[0].panes).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('starts a new row when a pane repeats, and never merges bus messages', () => {
    const bus = (ref: string, t: number) =>
      host('a', t, { host: 'bus', from: 'a', to: 'b', message: 'message', state: 'queued', ref })
    const rows = model([
      host('a', 1000),
      host('a', 1200, { host: 'started' }),
      bus('m1', 1300),
      bus('m2', 1400),
    ])
    expect(rows?.stream.map((r) => [r.host, r.panes?.length])).toEqual([
      ['bus', undefined],
      ['bus', undefined],
      ['started', undefined],
      ['started', undefined],
    ])
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
      panes: [{ paneId: 'p1' }],
      events: () => [
        note(1, 'olderopenn', { needsYou: true }),
        note(2, 'plainnotea'),
        note(3, 'donedonedo', { needsYou: true, doneAt: 4 }),
        note(5, 'neweropenn', { needsYou: true, link: '/w/a.md' }),
      ],
    })
    expect(model.workspace?.agents).toEqual([])
    const shared = { pane: 'p1', label: { n: 1 }, open: true }
    expect(model.workspace?.notes).toEqual([
      {
        id: 'neweropenn',
        t: 5,
        text: 'neweropenn',
        needsYou: true,
        done: false,
        link: '/w/a.md',
        ...shared,
      },
      { id: 'olderopenn', t: 1, text: 'olderopenn', needsYou: true, done: false, ...shared },
      { id: 'donedonedo', t: 3, text: 'donedonedo', needsYou: true, done: true, ...shared },
      { id: 'plainnotea', t: 2, text: 'plainnotea', needsYou: false, done: false, ...shared },
    ])
  })

  it('carries the pane of a note so it can be shown, and says whether that pane is still open', () => {
    const model = panelModel({
      showActivity: false,
      workspace: { workspaceId: 'w1', name: 'shop' },
      panes: [{ paneId: 'live', title: 'Fix upload' }],
      events: () => [
        note(1, 'liveliveli', { pane: 'live', needsYou: true }),
        note(2, 'gonegonego', { pane: 'gone', needsYou: true }),
      ],
    })
    expect(model.workspace?.notes.map((n) => [n.id, n.pane, n.open, n.label.title])).toEqual([
      ['gonegonego', 'gone', false, undefined],
      ['liveliveli', 'live', true, 'Fix upload'],
    ])
  })
})

describe('pane labels', () => {
  const labels = (panes: { paneId: string; title?: string }[], records: ActivityEvent[]) => {
    const workspace = panelModel({
      showActivity: true,
      workspace: { workspaceId: 'w', name: 'w' },
      panes,
      events: () => records,
    }).workspace
    return workspace?.agents.map((a) => a.label)
  }

  it('uses the tab title of each pane', () => {
    expect(
      labels(
        [
          { paneId: 'a', title: 'Fix flaky upload test' },
          { paneId: 'b', title: 'Write docs' },
        ],
        [ev('a', 'prompt', 'x'), ev('b', 'prompt', 'y')],
      ),
    ).toEqual([
      { agent: 'claude', title: 'Fix flaky upload test', n: 1 },
      { agent: 'claude', title: 'Write docs', n: 1 },
    ])
  })

  it('numbers panes that share a title in the order they first appeared', () => {
    const records = [ev('b', 'prompt', 'x'), ev('a', 'prompt', 'y'), ev('c', 'prompt', 'z')]
    expect(
      labels(
        [
          { paneId: 'a', title: 'claude' },
          { paneId: 'b', title: 'claude' },
          { paneId: 'c', title: 'other' },
        ],
        records,
      )?.map((l) => [l.title, l.n]),
    ).toEqual([
      ['claude', 1],
      ['claude', 2],
      ['other', 1],
    ])
  })

  it('falls back to the agent and its number when the title is empty, counting titled peers', () => {
    expect(
      labels(
        [
          { paneId: 'a', title: 'Fix flaky upload test' },
          { paneId: 'b', title: '  ' },
          { paneId: 'c' },
        ],
        [ev('a', 'prompt', 'x'), ev('b', 'prompt', 'y'), ev('c', 'prompt', 'z')],
      ),
    ).toEqual([
      { agent: 'claude', title: 'Fix flaky upload test', n: 1 },
      { agent: 'claude', n: 2 },
      { agent: 'claude', n: 3 },
    ])
  })

  it('breaks a tie between panes first seen at the same moment by pane id', () => {
    const at = (pane: string) => ev(pane, 'prompt', 'x', { t: 5 })
    expect(labels([{ paneId: 'b' }, { paneId: 'a' }], [at('b'), at('a')])?.map((l) => l.n)).toEqual(
      [2, 1],
    )
  })
})

describe('liveKeys', () => {
  it('names the panes, notes and turn groups the model still shows', () => {
    const first = ev('p', 'prompt', 'one')
    const second = ev('p', 'prompt', 'two')
    const workspace = panelModel({
      showActivity: true,
      workspace: { workspaceId: 'w', name: 'w' },
      panes: [{ paneId: 'p' }],
      events: () => [
        first,
        second,
        {
          v: 2,
          t: 1,
          id: 'noteidaaaa',
          pane: 'p',
          kind: 'note',
          text: 'n',
        },
      ],
    }).workspace
    const live = liveKeys(workspace)
    expect([...live.panes]).toEqual(['p'])
    expect([...live.notes]).toEqual(['noteidaaaa'])
    expect(live.groups).toEqual(new Set([groupKey('p', first.t), groupKey('p', second.t)]))
    expect(liveKeys(null).panes.size).toBe(0)
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

describe('wrapper-only prompts', () => {
  const agentOf = (events: ActivityEvent[]) =>
    panelModel({
      showActivity: true,
      workspace: { workspaceId: 'w', name: 'w' },
      panes: [{ paneId: 'p' }, { paneId: 'sender' }],
      events: () => [...events, ev('sender', 'prompt', 'hello')],
    }).workspace?.agents.find((a) => a.paneId === 'p')

  it.each([
    ['<pasted_content id="a739">', 'pasted'],
    ['<pasted_content>', 'pasted'],
    ['<task-notification>', 'task'],
    ['<system-reminder>', 'reminder'],
    ['<ostia-bus-messages>', 'message'],
  ])('labels %s instead of showing the tag', (text, kind) => {
    const current = agentOf([ev('p', 'prompt', text)])?.current
    expect(current?.wrapper).toEqual({ kind })
    expect(current?.prompt).toBeUndefined()
    expect(JSON.stringify(current)).toContain(kind)
  })

  it('names the pane a bus message block comes from', () => {
    const current = agentOf([
      ev('p', 'prompt', '<message id="m1" from="sender" at="2026-10-20T08:00:00.000Z">'),
    ])?.current
    expect(current?.wrapper).toEqual({ kind: 'message', from: { agent: 'claude', n: 2 } })
  })

  it('labels a wrapper with its closing tag and nothing else, and ignores surrounding blanks', () => {
    expect(
      agentOf([ev('p', 'prompt', '<system-reminder></system-reminder>')])?.current.wrapper,
    ).toEqual({
      kind: 'reminder',
    })
    expect(
      agentOf([ev('p', 'prompt', '  <pasted_content id="a1"> </pasted_content>  ')])?.current
        .wrapper,
    ).toEqual({
      kind: 'pasted',
    })
    expect(agentOf([ev('p', 'prompt', '\t<task-notification>')])?.current.wrapper).toEqual({
      kind: 'task',
    })
  })

  it.each([
    '<task-notification> why did the build fail',
    '<pasted_content id="a1">log</pasted_content> fix this',
    '<system-reminder>be brief</system-reminder>',
    'explain <pasted_content> tags',
    '<div>fix it</div>',
    '<pasted_content-x>',
    '<message id="m1" at="t">hello',
  ])('keeps %s as the human wrote it', (text) => {
    const current = agentOf([ev('p', 'prompt', text)])?.current
    expect(current?.prompt).toBe(text)
    expect(current?.wrapper).toBeUndefined()
  })

  it('leaves the stored event text untouched', () => {
    const stored = ev('p', 'prompt', '<pasted_content id="a739">')
    agentOf([stored])
    expect(stored.text).toBe('<pasted_content id="a739">')
  })
})

describe('limitsDigest', () => {
  it('is the same for the same limits in any order and differs when one changes', () => {
    expect(limitsDigest({ a: 1, b: 2 })).toBe(limitsDigest({ b: 2, a: 1 }))
    expect(limitsDigest({ a: 1 })).not.toBe(limitsDigest({ a: 2 }))
    expect(limitsDigest({})).toBe('')
  })
})

describe('widen', () => {
  it('asks for one more page when the sentinel shows all that is loaded, and not twice for the same page', () => {
    const limits = new Map<string, number>()
    expect(widen(limits, 'agent:p', TURN_PAGE)).toBe(true)
    expect(limits.get('agent:p')).toBe(TURN_PAGE * 2)
    expect(widen(limits, 'agent:p', TURN_PAGE)).toBe(false)
    expect(limits.get('agent:p')).toBe(TURN_PAGE * 2)
    expect(widen(limits, 'agent:p', TURN_PAGE * 2)).toBe(true)
    expect(limits.get('agent:p')).toBe(TURN_PAGE * 3)
  })
})

describe('widen for the workspace events', () => {
  it('asks for a page of events, which is larger than a page of turns', () => {
    const limits = new Map<string, number>()
    expect(widen(limits, STREAM_LIMIT_KEY, STREAM_PAGE)).toBe(true)
    expect(limits.get(STREAM_LIMIT_KEY)).toBe(STREAM_PAGE * 2)
    expect(STREAM_PAGE).toBeGreaterThan(TURN_PAGE)
  })
})
