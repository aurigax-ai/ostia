import { describe, expect, it } from 'vitest'
import { parsePaneArgs, parseWorkspaceRenameArgs } from './pane'

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
    expect(() => parsePaneArgs(['close', 'p1'])).toThrow('usage: ostia pane')
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
