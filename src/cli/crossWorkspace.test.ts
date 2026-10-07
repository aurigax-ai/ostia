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
    expect(() => pickWorkspace(rows, 'dup')).toThrow('matches 2 workspaces: w3 (dup), w4 (dup)')
    expect(() => pickWorkspace(rows, 'nope')).toThrow("no workspace 'nope'")
  })
})

describe('pickWorkspace with names the human gave', () => {
  const named = [
    { workspaceId: 'wf-1', name: 'home' },
    { workspaceId: 'wf-2', name: 'home', customName: 'W-one' },
    { workspaceId: 'wf-3', name: 'home', customName: 'W-two' },
    { workspaceId: 'wf-4', name: 'repo', customName: 'twin' },
    { workspaceId: 'wf-5', name: 'other', customName: 'twin' },
  ]

  it('finds a workspace by the name shown in the rail', () => {
    expect(pickWorkspace(named, 'W-two')).toBe('wf-3')
    expect(pickWorkspace(named, 'W-one')).toBe('wf-2')
  })

  it('matches the shown name before the folder name', () => {
    expect(pickWorkspace(named, 'home')).toBe('wf-1')
  })

  it('falls back to the folder name when no shown name matches', () => {
    expect(pickWorkspace(named, 'repo')).toBe('wf-4')
  })

  it('lists every candidate with its folder when the shown name is taken twice', () => {
    expect(() => pickWorkspace(named, 'twin')).toThrow(
      "workspace name 'twin' matches 2 workspaces: wf-4 (twin, folder repo), wf-5 (twin, folder other); pass the id",
    )
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
