import { describe, expect, it } from 'vitest'
import { parsePaneArgs, parseWorkspaceRenameArgs, waitOutcome, wakeOutcome } from './pane'

describe('parsePaneArgs', () => {
  it('joins the words of send into one text and adds Enter only when asked', () => {
    expect(parsePaneArgs(['send', 'worker', 'hello', 'world'])).toEqual({
      method: 'pane.input',
      params: { pane: 'worker', text: 'hello world' },
    })
    expect(parsePaneArgs(['send', 'worker', 'y', '--enter'])).toEqual({
      method: 'pane.input',
      params: { pane: 'worker', text: 'y', keys: ['enter'] },
    })
    expect(parsePaneArgs(['send', 'worker', '--enter'])).toEqual({
      method: 'pane.input',
      params: { pane: 'worker', keys: ['enter'] },
    })
  })

  it('sends everything after -- as text, flags included', () => {
    expect(parsePaneArgs(['send', 'worker', '--', 'git', 'commit', '--enter'])).toEqual({
      method: 'pane.input',
      params: { pane: 'worker', text: 'git commit --enter' },
    })
  })

  it('keeps unknown flags of send as text and reads --enter wherever it stands', () => {
    expect(parsePaneArgs(['send', 'worker', '--enter', 'git', 'commit', '-m', 'fix -1'])).toEqual({
      method: 'pane.input',
      params: { pane: 'worker', text: 'git commit -m fix -1', keys: ['enter'] },
    })
  })

  it('reads the flags for unattended sends and a task from stdin', () => {
    expect(
      parsePaneArgs(['send', 'w', '--paste', '--force', '--confirm', '--enter', 'do', 'it']),
    ).toEqual({
      method: 'pane.input',
      params: {
        pane: 'w',
        text: 'do it',
        keys: ['enter'],
        paste: true,
        force: true,
        confirm: true,
      },
    })
    expect(parsePaneArgs(['send', 'w', '--raw', 'a'])).toEqual({
      method: 'pane.input',
      params: { pane: 'w', text: 'a', paste: false },
    })
    expect(parsePaneArgs(['send', 'w', '--enter', '-'])).toEqual({
      method: 'pane.input',
      params: { pane: 'w', keys: ['enter'] },
      stdin: true,
    })
    expect(() => parsePaneArgs(['send', 'w', '--paste', '--raw', 'a'])).toThrow('usage: ostia pane')
  })

  it('passes the keys of key through in order', () => {
    expect(parsePaneArgs(['key', 'p1', 'ctrl-c', 'up', 'enter'])).toEqual({
      method: 'pane.input',
      params: { pane: 'p1', keys: ['ctrl-c', 'up', 'enter'] },
    })
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
    expect(() => parsePaneArgs(['read', 'p1', '--tail', '5'])).toThrow('usage: ostia pane')
    expect(() => parsePaneArgs(['read', 'p1', 'extra'])).toThrow('usage: ostia pane')
  })

  it('refuses a missing pane, empty input and an unknown subcommand', () => {
    expect(() => parsePaneArgs(['send'])).toThrow('usage: ostia pane')
    expect(() => parsePaneArgs(['send', 'p1'])).toThrow('usage: ostia pane')
    expect(() => parsePaneArgs(['key', 'p1'])).toThrow('usage: ostia pane')
    expect(() => parsePaneArgs(['frobnicate', 'p1'])).toThrow('usage: ostia pane')
  })

  it('points pane list at the pane.list command', () => {
    for (const argv of [['list'], ['list', '--json']]) {
      expect(() => parsePaneArgs(argv)).toThrow(
        'list panes with ostia pane.list (JSON), not ostia pane list',
      )
    }
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

describe('parseWorkspaceRenameArgs', () => {
  it('renames your own workspace, or the one named with --workspace', () => {
    expect(parseWorkspaceRenameArgs(['research', 'line'])).toEqual({ name: 'research line' })
    expect(parseWorkspaceRenameArgs(['--workspace', 'ws2', 'api'])).toEqual({
      workspace: 'ws2',
      name: 'api',
    })
    expect(parseWorkspaceRenameArgs(['--clear'])).toEqual({ name: '' })
  })

  it('refuses no name and a name with --clear', () => {
    expect(() => parseWorkspaceRenameArgs([])).toThrow('usage: ostia workspace rename')
    expect(() => parseWorkspaceRenameArgs(['--clear', 'x'])).toThrow(
      'usage: ostia workspace rename',
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

  it('takes --wait with an optional --timeout in seconds', () => {
    expect(parsePaneArgs(['wake', 'fixer', '--wait'])).toEqual({
      method: 'pane.wake',
      params: { panes: ['fixer'], wait: true },
      json: false,
    })
    expect(parsePaneArgs(['wake', 'fixer', '--wait', '--timeout', '30'])).toEqual({
      method: 'pane.wake',
      params: { panes: ['fixer'], wait: true, timeoutMs: 30_000 },
      json: false,
    })
    expect(() => parsePaneArgs(['wake', 'fixer', '--timeout', '30'])).toThrow(
      '--timeout needs --wait',
    )
    expect(() => parsePaneArgs(['wake', 'fixer', '--wait', '--timeout', 'soon'])).toThrow(
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
    expect(() => parsePaneArgs(['close'])).toThrow('ostia pane close <pane>')
  })
})
