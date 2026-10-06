import { describe, expect, it } from 'vitest'
import { buildCommandCall, parseCommandFlags, pickWorkspace } from './crossWorkspace'

const rows = [
  { workspaceId: 'w1', name: 'main' },
  { workspaceId: 'w2', name: 'research' },
  { workspaceId: 'w3', name: 'dup' },
  { workspaceId: 'w4', name: 'dup' },
]

describe('pickWorkspace', () => {
  it('takes an id as is, and a name that only one workspace has', () => {
    expect(pickWorkspace(rows, 'w2')).toBe('w2')
    expect(pickWorkspace(rows, 'research')).toBe('w2')
  })

  it('prefers an id over a workspace that happens to be named like it', () => {
    expect(pickWorkspace([...rows, { workspaceId: 'w9', name: 'w1' }], 'w1')).toBe('w1')
  })

  it('refuses an ambiguous name, naming the ids, and an unknown one', () => {
    expect(() => pickWorkspace(rows, 'dup')).toThrow('ambiguous (w3, w4)')
    expect(() => pickWorkspace(rows, 'nope')).toThrow("no workspace 'nope'")
  })
})

describe('parseCommandFlags', () => {
  it('pulls --workspace (two spellings) and --no-focus out and keeps the rest in order', () => {
    expect(parseCommandFlags(['{"a":1}', '--workspace', 'w2'])).toEqual({
      workspace: 'w2',
      noFocus: false,
      rest: ['{"a":1}'],
    })
    expect(parseCommandFlags(['--workspace=w2', '--no-focus'])).toEqual({
      workspace: 'w2',
      noFocus: true,
      rest: [],
    })
    expect(parseCommandFlags([])).toEqual({ noFocus: false, rest: [] })
  })

  it('refuses --workspace without a value', () => {
    expect(() => parseCommandFlags(['--workspace'])).toThrow('--workspace needs a value')
    expect(() => parseCommandFlags(['--workspace='])).toThrow('--workspace needs a value')
  })
})

describe('buildCommandCall', () => {
  it('sends no target and no args for a bare command', () => {
    expect(buildCommandCall('tab.new', parseCommandFlags([]), undefined)).toEqual({ id: 'tab.new' })
  })

  it('targets the resolved workspace without a pane, so the app picks that workspace pane', () => {
    expect(buildCommandCall('tab.new', parseCommandFlags(['--workspace', 'x']), 'w2')).toEqual({
      id: 'tab.new',
      target: { workspaceId: 'w2', paneId: null },
    })
  })

  it('turns --no-focus into focus:false next to the JSON args given', () => {
    expect(buildCommandCall('workspace.new', parseCommandFlags(['--no-focus']), undefined)).toEqual(
      { id: 'workspace.new', args: { focus: false } },
    )
    expect(
      buildCommandCall(
        'workspace.new',
        parseCommandFlags(['{"name":"w","focus":true}', '--no-focus']),
        undefined,
      ),
    ).toEqual({ id: 'workspace.new', args: { name: 'w', focus: false } })
  })

  it('refuses --no-focus on any other command', () => {
    expect(() => buildCommandCall('tab.new', parseCommandFlags(['--no-focus']), undefined)).toThrow(
      'only applies to workspace.new',
    )
  })
})
