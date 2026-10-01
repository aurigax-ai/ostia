import { describe, expect, it } from 'vitest'
import { parsePaneArgs } from './pane'

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
  })

  it('refuses a missing pane, empty input and an unknown subcommand', () => {
    expect(() => parsePaneArgs(['send'])).toThrow('usage: pine pane')
    expect(() => parsePaneArgs(['send', 'p1'])).toThrow('usage: pine pane')
    expect(() => parsePaneArgs(['key', 'p1'])).toThrow('usage: pine pane')
    expect(() => parsePaneArgs(['close', 'p1'])).toThrow('usage: pine pane')
  })
})
