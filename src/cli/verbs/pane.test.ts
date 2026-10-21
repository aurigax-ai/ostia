import { describe, expect, it } from 'vitest'
import type { PaneStatus } from '../../shared/panes/paneStatus'
import {
  closeLines,
  filterPanes,
  hibernateOutcome,
  inputLine,
  nameLine,
  paneLine,
  parsePaneArgs,
  waitOutcome,
  wakeOutcome,
} from './pane'

describe('parsePaneArgs', () => {
  it('joins the words of send into one text and adds Enter only when asked', () => {
    expect(parsePaneArgs(['send', 'worker', 'hello', 'world'])).toEqual({
      method: 'pane.input',
      params: { pane: 'worker', text: 'hello world' },
      json: false,
    })
    expect(parsePaneArgs(['send', 'worker', 'y', '--enter'])).toEqual({
      method: 'pane.input',
      params: { pane: 'worker', text: 'y', keys: ['enter'] },
      json: false,
    })
    expect(parsePaneArgs(['send', 'worker', '--enter'])).toEqual({
      method: 'pane.input',
      params: { pane: 'worker', keys: ['enter'] },
      json: false,
    })
  })

  it('sends everything after -- as text, flags included', () => {
    expect(parsePaneArgs(['send', 'worker', '--', 'git', 'commit', '--enter'])).toEqual({
      method: 'pane.input',
      params: { pane: 'worker', text: 'git commit --enter' },
      json: false,
    })
  })

  it('refuses an unknown flag of send, and takes text with dashes after --', () => {
    expect(() => parsePaneArgs(['send', 'worker', '--enter', 'git', 'commit', '-m', 'x'])).toThrow(
      'unknown flag -m',
    )
    expect(
      parsePaneArgs(['send', 'worker', '--enter', '--', 'git', 'commit', '-m', 'fix -1']),
    ).toEqual({
      method: 'pane.input',
      params: { pane: 'worker', text: 'git commit -m fix -1', keys: ['enter'] },
      json: false,
    })
  })

  it('reads the flags for unattended sends and a task from stdin', () => {
    expect(parsePaneArgs(['send', 'w', '--paste', '--force', '--enter', 'do', 'it'])).toEqual({
      method: 'pane.input',
      params: {
        pane: 'w',
        text: 'do it',
        keys: ['enter'],
        paste: true,
        force: true,
      },
      json: false,
    })
    expect(parsePaneArgs(['send', 'w', '--raw', 'a'])).toEqual({
      method: 'pane.input',
      params: { pane: 'w', text: 'a', paste: false },
      json: false,
    })
    expect(parsePaneArgs(['send', 'w', '--enter', '-'])).toEqual({
      method: 'pane.input',
      params: { pane: 'w', keys: ['enter'] },
      stdin: true,
      json: false,
    })
    expect(() => parsePaneArgs(['send', 'w', '--paste', '--raw', 'a'])).toThrow('usage: ostia pane')
    expect(() => parsePaneArgs(['send', 'w', '--confirm', 'a'])).toThrow('unknown flag --confirm')
    expect(parsePaneArgs(['send', 'w', '--', '--not-a-flag'])).toMatchObject({
      params: { text: '--not-a-flag' },
    })
  })

  it('passes the keys of key through in order', () => {
    expect(parsePaneArgs(['key', 'p1', 'ctrl-c', 'up', 'enter'])).toEqual({
      method: 'pane.input',
      params: { pane: 'p1', keys: ['ctrl-c', 'up', 'enter'] },
      json: false,
    })
    expect(parsePaneArgs(['key', 'p1', 'enter', '--json'])).toMatchObject({ json: true })
    expect(parsePaneArgs(['send', 'p1', 'x', '--json'])).toMatchObject({ json: true })
  })

  it('answers send and key with what the pane did', () => {
    const base = { paneId: 'p1', responded: true, turnStarted: false, running: true }
    expect(inputLine({ ...base, turnStarted: true })).toBe('ok: p1 started a turn')
    expect(inputLine(base)).toBe('ok: p1 showed new output; a command is running')
    expect(inputLine({ ...base, responded: false, running: false })).toBe(
      'sent; p1 showed nothing yet (no command is running): read it with ostia pane read p1',
    )
  })

  it('reads with an optional line count and JSON output', () => {
    expect(parsePaneArgs(['read', 'p1'])).toEqual({
      method: 'pane.read',
      params: { pane: 'p1' },
      json: false,
    })
    expect(parsePaneArgs(['read', 'p1', '--lines', '40', '--json'])).toEqual({
      method: 'pane.read',
      params: { pane: 'p1', lines: 40 },
      json: true,
    })
    expect(() => parsePaneArgs(['read', 'p1', '--lines', '0'])).toThrow('positive')
    expect(() => parsePaneArgs(['read', 'p1', '--lines', '-3'])).toThrow('positive')
    expect(() => parsePaneArgs(['read', 'p1', '--lines'])).toThrow('--lines needs a value')
    expect(() => parsePaneArgs(['read', 'p1', '--tail', '5'])).toThrow('unknown flag --tail')
    expect(() => parsePaneArgs(['read', 'p1', 'extra'])).toThrow('usage: ostia pane')
  })

  it('refuses a missing pane, empty input and an unknown subcommand', () => {
    expect(() => parsePaneArgs(['send'])).toThrow('usage: ostia pane')
    expect(() => parsePaneArgs(['send', 'p1'])).toThrow('usage: ostia pane')
    expect(() => parsePaneArgs(['key', 'p1'])).toThrow('usage: ostia pane')
    expect(() => parsePaneArgs(['frobnicate', 'p1'])).toThrow('usage: ostia pane')
  })

  it('lists panes as text lines, or JSON with --json, and takes nothing more', () => {
    expect(parsePaneArgs(['list'])).toEqual({ method: 'pane.list', params: {}, json: false })
    expect(parsePaneArgs(['list', '--json'])).toEqual({
      method: 'pane.list',
      params: {},
      json: true,
    })
    expect(() => parsePaneArgs(['list', 'p1'])).toThrow('usage: ostia pane <verb>')
  })
})

describe('paneLine', () => {
  it('prints id, workspace, kind, state and title, the state from sleep, agent or command', () => {
    const pane = { paneId: 'p1', workspaceId: 'ws1', kind: 'terminal', title: 'w-1', running: true }
    expect(paneLine(pane)).toBe('p1\tws1\tterminal\trunning\tw-1')
    expect(paneLine({ ...pane, running: false })).toBe('p1\tws1\tterminal\tidle\tw-1')
    expect(paneLine({ ...pane, agentState: 'waiting' })).toBe('p1\tws1\tterminal\twaiting\tw-1')
    expect(paneLine({ ...pane, agentState: 'working', waking: true })).toContain('\twaking\t')
    expect(paneLine({ ...pane, hibernated: true, waking: true })).toContain('\thibernated\t')
  })

  it('keeps a title with tabs, newlines or control characters on one line of five fields', () => {
    const pane = { paneId: 'p1', workspaceId: 'ws1', kind: 'terminal', running: true }
    const line = paneLine({ ...pane, title: 'a\tb\nc\u001b[31m' })
    expect(line).toBe('p1\tws1\tterminal\trunning\ta\\tb\\nc\\x1b[31m')
    expect(line.split('\t')).toHaveLength(5)
  })
})

describe('pane rename', () => {
  it('joins the title words and accepts --clear instead of a title', () => {
    expect(parsePaneArgs(['rename', 'p1', 'W9', '控制面補齊'])).toEqual({
      method: 'pane.rename',
      params: { pane: 'p1', title: 'W9 控制面補齊' },
    })
    expect(parsePaneArgs(['rename', 'p1', '--clear'])).toEqual({
      method: 'pane.rename',
      params: { pane: 'p1', title: '' },
    })
  })

  it('refuses a missing title, and a title together with --clear', () => {
    expect(() => parsePaneArgs(['rename', 'p1'])).toThrow('usage: ostia pane')
    expect(() => parsePaneArgs(['rename', 'p1', '--clear', 'x'])).toThrow('usage: ostia pane')
  })
})

describe('pane status', () => {
  it('takes several panes and --json, and none means the caller’s workspace', () => {
    expect(parsePaneArgs(['status', 'w1', 'w2'])).toEqual({
      method: 'pane.status',
      params: { panes: ['w1', 'w2'] },
      json: false,
    })
    expect(parsePaneArgs(['status', 'w1', '--json'])).toEqual({
      method: 'pane.status',
      params: { panes: ['w1'] },
      json: true,
    })
    expect(parsePaneArgs(['status'])).toEqual({ method: 'pane.status', params: {}, json: false })
    expect(parsePaneArgs(['status', '--json'])).toEqual({
      method: 'pane.status',
      params: {},
      json: true,
    })
    expect(() => parsePaneArgs(['status', 'w1', '--lines', '3'])).toThrow()
  })
})

describe('pane transcript', () => {
  it('takes one pane, --turns or --full, and --json', () => {
    expect(parsePaneArgs(['transcript', 'w1'])).toEqual({
      method: 'pane.transcript',
      params: { pane: 'w1' },
      json: false,
    })
    expect(parsePaneArgs(['transcript', 'w1', '--turns', '3', '--json'])).toEqual({
      method: 'pane.transcript',
      params: { pane: 'w1', turns: 3 },
      json: true,
    })
    expect(parsePaneArgs(['transcript', 'w1', '--full'])).toEqual({
      method: 'pane.transcript',
      params: { pane: 'w1', full: true },
      json: false,
    })
  })

  it('refuses several panes, --turns with --full, and a turn count that is not a whole number', () => {
    expect(() => parsePaneArgs(['transcript', 'w1', 'w2'])).toThrow('usage: ostia pane')
    expect(() => parsePaneArgs(['transcript', 'w1', '--full', '--turns', '2'])).toThrow(
      'usage: ostia pane',
    )
    expect(() => parsePaneArgs(['transcript', 'w1', '--turns', '0'])).toThrow('positive integer')
    expect(() => parsePaneArgs(['transcript', 'w1', '--turns', 'x'])).toThrow('positive integer')
  })
})

describe('pane watch', () => {
  it('takes panes and repeated --until, or --off with or without panes', () => {
    expect(parsePaneArgs(['watch', 'w1', 'w2', '--until', 'done', '--until', 'error'])).toEqual({
      method: 'pane.watch',
      params: { panes: ['w1', 'w2'], until: ['done', 'error'] },
      json: false,
    })
    expect(parsePaneArgs(['watch', 'w1', '--off'])).toEqual({
      method: 'pane.watch',
      params: { panes: ['w1'], off: true },
      json: false,
    })
    expect(parsePaneArgs(['watch', '--off', '--json'])).toEqual({
      method: 'pane.watch',
      params: { off: true },
      json: true,
    })
  })

  it('refuses a watch without a pane, and --off together with --until', () => {
    expect(() => parsePaneArgs(['watch'])).toThrow('usage: ostia pane')
    expect(() => parsePaneArgs(['watch', 'w1', '--off', '--until', 'done'])).toThrow(
      'usage: ostia pane',
    )
  })
})

describe('pane wait', () => {
  it('takes several panes, repeated --until and seconds for --timeout', () => {
    expect(
      parsePaneArgs([
        'wait',
        'fixer',
        'w2',
        '--until',
        'waiting',
        '--until',
        'idle',
        '--timeout',
        '90',
      ]),
    ).toEqual({
      method: 'pane.wait',
      params: { panes: ['fixer', 'w2'], until: ['waiting', 'idle'], timeoutMs: 90_000 },
      json: false,
    })
    expect(parsePaneArgs(['wait', 'fixer', '--json'])).toEqual({
      method: 'pane.wait',
      params: { panes: ['fixer'] },
      json: true,
    })
    expect(() => parsePaneArgs(['wait', 'fixer', '--timeout', 'soon'])).toThrow(
      "--timeout expects seconds, got 'soon'",
    )
  })

  it('exits 0 when reached, 3 when timed out and 4 when the pane closed', () => {
    const reached = { reached: true as const, paneId: 'p1', state: 'waiting', message: 'Allow?' }
    expect(waitOutcome(reached, false)).toEqual({ line: 'p1\twaiting\tAllow?', code: 0 })
    expect(waitOutcome(reached, true)).toEqual({
      line: JSON.stringify({ paneId: 'p1', state: 'waiting', message: 'Allow?' }),
      code: 0,
    })
    const status: PaneStatus = {
      pane: 'p1',
      title: 'w-1',
      state: 'shell',
      exitCode: 2,
      mail: { queued: 0, failed: 0, sentQueued: 0, sentFailed: 0 },
      stale: [],
      conflict: [],
      changes: { first: true, states: [], commands: 0, failed: 0, closing: false, mail: 0 },
    }
    const command = { reached: true as const, paneId: 'p1', state: 'command', exitCode: 2, status }
    expect(waitOutcome(command, false).line).toBe('p1  w-1  shell  exit 2  mail 0  (first look)')
    expect(JSON.parse(waitOutcome(command, true).line)).toMatchObject({
      paneId: 'p1',
      state: 'command',
      exitCode: 2,
      status: { title: 'w-1' },
    })
    expect(waitOutcome({ timedOut: true }, false).code).toBe(3)
    expect(waitOutcome({ closed: true, paneId: 'p1' }, false)).toEqual({
      line: 'ostia pane wait: p1 closed',
      code: 4,
    })
  })
})

describe('pane wake', () => {
  it('takes one or more panes and --json', () => {
    expect(parsePaneArgs(['wake', 'fixer', 'w2'])).toEqual({
      method: 'pane.wake',
      params: { panes: ['fixer', 'w2'] },
      json: false,
    })
    expect(parsePaneArgs(['wake', 'fixer', '--json'])).toEqual({
      method: 'pane.wake',
      params: { panes: ['fixer'] },
      json: true,
    })
    expect(() => parsePaneArgs(['wake'])).toThrow('ostia pane wake <pane>')
  })

  it('always waits for the start, with an optional --timeout in seconds and no --wait flag', () => {
    expect(parsePaneArgs(['wake', 'fixer', '--timeout', '30'])).toEqual({
      method: 'pane.wake',
      params: { panes: ['fixer'], timeoutMs: 30_000 },
      json: false,
    })
    expect(() => parsePaneArgs(['wake', 'fixer', '--wait'])).toThrow('unknown flag --wait')
    expect(() => parsePaneArgs(['wake', 'fixer', '--timeout', 'soon'])).toThrow(
      "--timeout expects seconds, got 'soon'",
    )
  })

  it('exits 0 once started, 3 on timeout and 4 when a pane closed', () => {
    expect(wakeOutcome({ woke: ['p1', 'p2'], started: true }, false)).toEqual({
      line: 'p1\np2',
      code: 0,
    })
    expect(wakeOutcome({ woke: ['p1'] }, true)).toEqual({ line: '{"woke":["p1"]}', code: 0 })
    expect(wakeOutcome({ woke: ['p1'], timedOut: true }, false)).toEqual({
      line: 'ostia pane wake: timed out',
      code: 3,
    })
    expect(wakeOutcome({ woke: ['p1'], closed: 'p1' }, false)).toEqual({
      line: 'ostia pane wake: p1 closed',
      code: 4,
    })
  })
})

describe('pane hibernate', () => {
  it('takes one or more panes and --json', () => {
    expect(parsePaneArgs(['hibernate', 'fixer', 'w2'])).toEqual({
      method: 'pane.hibernate',
      params: { panes: ['fixer', 'w2'] },
      json: false,
    })
    expect(parsePaneArgs(['hibernate', 'fixer', '--json'])).toEqual({
      method: 'pane.hibernate',
      params: { panes: ['fixer'] },
      json: true,
    })
    expect(() => parsePaneArgs(['hibernate'])).toThrow('ostia pane hibernate <pane>')
  })

  it('exits 0 when every pane went to sleep and 2 when one was skipped', () => {
    expect(hibernateOutcome({ hibernated: ['p1', 'p2'], skipped: {} }, false)).toEqual({
      line: 'p1\np2',
      code: 0,
    })
    expect(hibernateOutcome({ hibernated: ['p1'], skipped: { p2: 'subagent' } }, false)).toEqual({
      line: 'p1\nostia pane hibernate: p2 skipped (subagent)',
      code: 2,
    })
    expect(hibernateOutcome({ hibernated: [], skipped: { p2: 'not-agent' } }, true)).toEqual({
      line: '{"hibernated":[],"skipped":{"p2":"not-agent"}}',
      code: 2,
    })
  })
})

describe('pane close', () => {
  it('takes one or more panes and --json', () => {
    expect(parsePaneArgs(['close', 'fixer', 'w2'])).toEqual({
      method: 'pane.close',
      params: { panes: ['fixer', 'w2'] },
      json: false,
    })
    expect(parsePaneArgs(['close', 'fixer', '--json'])).toEqual({
      method: 'pane.close',
      params: { panes: ['fixer'] },
      json: true,
    })
    expect(parsePaneArgs(['close'])).toEqual({ method: 'pane.close', params: {}, json: false })
  })
})

describe('pane move', () => {
  it('takes one or more panes, a --workspace and --json', () => {
    expect(parsePaneArgs(['move', 'fixer', 'w2', '--workspace', 'api · workers'])).toEqual({
      method: 'pane.moveTo',
      params: { panes: ['fixer', 'w2'], workspace: 'api · workers' },
      json: false,
    })
    expect(parsePaneArgs(['move', 'fixer', '--workspace', 'w3', '--json'])).toEqual({
      method: 'pane.moveTo',
      params: { panes: ['fixer'], workspace: 'w3' },
      json: true,
    })
  })

  it('takes a split tab by name or new, with or without a workspace', () => {
    expect(parsePaneArgs(['move', 'fixer', 'w2', '--tab', 'api · workers'])).toEqual({
      method: 'pane.moveTo',
      params: { panes: ['fixer', 'w2'], tab: 'api · workers' },
      json: false,
    })
    expect(parsePaneArgs(['move', 'fixer', '--tab', 'new', '--workspace', 'w3'])).toEqual({
      method: 'pane.moveTo',
      params: { panes: ['fixer'], workspace: 'w3', tab: 'new' },
      json: false,
    })
  })

  it('needs a pane and a workspace or a tab', () => {
    expect(() => parsePaneArgs(['move', 'fixer'])).toThrow('ostia pane move <pane>')
    expect(() => parsePaneArgs(['move', '--workspace', 'w3'])).toThrow('ostia pane move <pane>')
  })
})

describe('pane list', () => {
  const pane = {
    paneId: '3f6a7ced-1111-4222-8333-444455556666',
    workspaceId: 'ws1',
    kind: 'terminal',
    title: 'w-1',
    running: true,
  }

  it('takes --here or --workspace, --state (several), --kind and --json', () => {
    expect(parsePaneArgs(['list'])).toEqual({ method: 'pane.list', params: {}, json: false })
    expect(
      parsePaneArgs([
        'list',
        '--here',
        '--state',
        'working',
        '--state',
        'waiting',
        '--kind',
        'terminal',
      ]),
    ).toEqual({
      method: 'pane.list',
      params: { here: true, states: ['working', 'waiting'], kind: 'terminal' },
      json: false,
    })
    expect(parsePaneArgs(['list', '--workspace', 'api', '--json'])).toEqual({
      method: 'pane.list',
      params: { workspace: 'api' },
      json: true,
    })
  })

  it('refuses --here with --workspace, a stray argument and a state it does not know', () => {
    expect(() => parsePaneArgs(['list', '--here', '--workspace', 'api'])).toThrow(
      'usage: ostia pane',
    )
    expect(() => parsePaneArgs(['list', 'extra'])).toThrow('usage: ostia pane')
    expect(() => parsePaneArgs(['list', '--state', 'asleep'])).toThrow('--state expects one of')
  })

  it('prints the first 8 characters of the id', () => {
    expect(paneLine(pane)).toBe('3f6a7ced\tws1\tterminal\trunning\tw-1')
  })

  it('keeps the panes of a workspace, a kind and any of the states', () => {
    const idle = { ...pane, paneId: 'b', running: false }
    const other = { ...pane, paneId: 'c', workspaceId: 'ws2', agentState: 'working' }
    const browser = { ...pane, paneId: 'd', kind: 'browser' }
    const all = [pane, idle, other, browser]
    expect(filterPanes(all, {})).toHaveLength(4)
    expect(filterPanes(all, { workspaceId: 'ws2' })).toEqual([other])
    expect(filterPanes(all, { kind: 'browser' })).toEqual([browser])
    expect(filterPanes(all, { states: ['idle', 'working'] })).toEqual([idle, other])
    expect(filterPanes(all, { workspaceId: 'ws1', kind: 'terminal', states: ['running'] })).toEqual(
      [pane],
    )
  })
})

describe('pane close answers', () => {
  it('lists what closed and what had closed already, with the age and the name', () => {
    expect(
      closeLines(
        {
          closed: ['3f6a7ced-1111-4222-8333-444455556666'],
          already: [
            { paneId: 'e6546de6-aaaa-4bbb-8ccc-ddddeeeeffff', closedAt: 0, name: 'w-1241' },
            { paneId: '99999999-aaaa-4bbb-8ccc-ddddeeeeffff', closedAt: 60_000 },
          ],
        },
        2 * 60 * 60_000,
      ),
    ).toEqual([
      '3f6a7ced',
      'e6546de6 already closed 2h ago (w-1241)',
      '99999999 already closed 1h ago',
    ])
  })
})

describe('pane wake answers', () => {
  it('names a pane that was awake already', () => {
    expect(
      wakeOutcome({ woke: [], already: ['3f6a7ced-1111-4222-8333-444455556666'] }, false),
    ).toEqual({ line: '3f6a7ced already awake', code: 0 })
  })
})

describe('pane name', () => {
  it('takes a name with an optional description, or --clear alone', () => {
    expect(parsePaneArgs(['name', 'boss', '--desc', 'plans the work'])).toEqual({
      method: 'pane.name',
      params: { name: 'boss', desc: 'plans the work' },
      json: false,
    })
    expect(parsePaneArgs(['name', '--clear', '--json'])).toEqual({
      method: 'pane.name',
      params: { clear: true },
      json: true,
    })
  })

  it('refuses no name, two names, and --clear with a name or a description', () => {
    for (const argv of [
      ['name'],
      ['name', 'a', 'b'],
      ['name', '--clear', 'a'],
      ['name', '--clear', '--desc', 'x'],
      ['name', '--desc', 'x'],
    ]) {
      expect(() => parsePaneArgs(argv), argv.join(' ')).toThrow()
    }
  })

  it('prints the short id, the name and the description', () => {
    expect(nameLine({ paneId: '3f6a7ced-0000', name: 'boss', desc: 'plans' })).toBe(
      '3f6a7ced\tboss\tplans',
    )
    expect(nameLine({ paneId: '3f6a7ced-0000' })).toBe('3f6a7ced has no name')
  })

  it('adds the name and description to a listed pane only when it has a name', () => {
    const pane = { paneId: 'p1', workspaceId: 'ws1', kind: 'terminal', title: 't', running: true }
    expect(paneLine({ ...pane, name: 'boss' })).toBe('p1\tws1\tterminal\trunning\tt\tboss')
    expect(paneLine({ ...pane, name: 'boss', description: 'plans' })).toBe(
      'p1\tws1\tterminal\trunning\tt\tboss\tplans',
    )
  })
})
