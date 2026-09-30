import { describe, expect, it } from 'vitest'
import {
  type Groupable,
  type Grouping,
  type WorkspaceGroup,
  applyDrop,
  createGroup,
  deleteGroup,
  insertWorkspace,
  joinGroup,
  leaveGroup,
  matchGroupRule,
  moveWorkspaceBy,
  normalizeGroups,
  patchGroup,
  pinWorkspace,
  toBlocks,
} from './workspaceGroups'

const group = (id: string, extra: Partial<WorkspaceGroup> = {}): WorkspaceGroup => ({
  id,
  name: id.toUpperCase(),
  ...extra,
})

function parse(spec: string): Groupable {
  const [id, groupId] = spec.replace('*', '').split(':')
  return {
    id,
    ...(spec.endsWith('*') ? { pinned: true } : {}),
    ...(groupId ? { groupId } : {}),
  }
}

function state(...spec: string[]): Grouping<Groupable> {
  const workspaces = spec.map(parse)
  const ids = [...new Set(workspaces.map((w) => w.groupId).filter((g): g is string => !!g))]
  return { workspaces, groups: ids.map((id) => group(id)) }
}

const layout = (g: Grouping<Groupable>) =>
  g.workspaces.map((w) => `${w.id}${w.groupId ? `:${w.groupId}` : ''}${w.pinned ? '*' : ''}`)

const groupIds = (g: Grouping<Groupable>) => g.groups.map((x) => x.id)

describe('normalizeGroups', () => {
  it('pulls a group’s members together at its first member', () => {
    expect(layout(normalizeGroups(state('a:g', 'b', 'c:g')))).toEqual(['a:g', 'c:g', 'b'])
  })

  it('drops a group with no members and orders groups as they appear', () => {
    const g = { ...state('a:h', 'b:g'), groups: [group('g'), group('empty'), group('h')] }
    expect(groupIds(normalizeGroups(g))).toEqual(['h', 'g'])
  })

  it('ungroups a pinned workspace and a workspace naming an unknown group', () => {
    const g = { workspaces: [parse('a:g*'), parse('b:gone')], groups: [group('g')] }
    const next = normalizeGroups(g)
    expect(layout(next)).toEqual(['a*', 'b'])
    expect(next.groups).toEqual([])
  })
})

describe('toBlocks', () => {
  it('yields one block per group and one per ungrouped workspace, in order', () => {
    const blocks = toBlocks(state('a', 'b:g', 'c:g', 'd'))
    expect(blocks.map((b) => [b.group?.id ?? null, b.workspaces.map((w) => w.id)])).toEqual([
      [null, ['a']],
      ['g', ['b', 'c']],
      [null, ['d']],
    ])
  })
})

describe('moveWorkspaceBy', () => {
  it('moves a grouped workspace only within its group', () => {
    const g = state('a', 'b:g', 'c:g', 'd')
    expect(layout(moveWorkspaceBy(g, 'c', -1))).toEqual(['a', 'c:g', 'b:g', 'd'])
    expect(moveWorkspaceBy(g, 'b', -1)).toBe(g)
    expect(moveWorkspaceBy(g, 'c', 1)).toBe(g)
  })

  it('steps an ungrouped workspace over a whole group', () => {
    const g = state('a', 'b:g', 'c:g', 'd')
    expect(layout(moveWorkspaceBy(g, 'd', -1))).toEqual(['a', 'd', 'b:g', 'c:g'])
    expect(layout(moveWorkspaceBy(g, 'a', 1))).toEqual(['b:g', 'c:g', 'a', 'd'])
  })

  it('never moves an unpinned workspace above a pinned one, or a pinned one below', () => {
    const g = state('a*', 'b', 'c')
    expect(moveWorkspaceBy(g, 'b', -1)).toBe(g)
    expect(moveWorkspaceBy(g, 'a', 1)).toBe(g)
    expect(layout(moveWorkspaceBy(g, 'c', -1))).toEqual(['a*', 'c', 'b'])
  })
})

describe('applyDrop', () => {
  it('joins the group of the row it is dropped next to', () => {
    const next = applyDrop(
      state('a', 'b:g', 'c:g'),
      { kind: 'workspace', id: 'a' },
      { kind: 'workspace', id: 'c', place: 'after' },
    )
    expect(layout(next)).toEqual(['b:g', 'c:g', 'a:g'])
  })

  it('leaves its group when dropped next to an ungrouped row, and drops the emptied group', () => {
    const next = applyDrop(
      state('a:g', 'b'),
      { kind: 'workspace', id: 'a' },
      { kind: 'workspace', id: 'b', place: 'after' },
    )
    expect(layout(next)).toEqual(['b', 'a'])
    expect(next.groups).toEqual([])
  })

  it('moves between groups', () => {
    const next = applyDrop(
      state('a:g', 'b:g', 'c:h'),
      { kind: 'workspace', id: 'b' },
      { kind: 'workspace', id: 'c', place: 'before' },
    )
    expect(layout(next)).toEqual(['a:g', 'b:h', 'c:h'])
  })

  it('drops onto a group header: inside makes it the first member, before places it above', () => {
    const g = state('a', 'b:g', 'c:g')
    expect(
      layout(
        applyDrop(g, { kind: 'workspace', id: 'a' }, { kind: 'group', id: 'g', place: 'inside' }),
      ),
    ).toEqual(['a:g', 'b:g', 'c:g'])
    expect(
      layout(
        applyDrop(g, { kind: 'workspace', id: 'c' }, { kind: 'group', id: 'g', place: 'before' }),
      ),
    ).toEqual(['a', 'c', 'b:g'])
  })

  it('drops at the end as an ungrouped workspace', () => {
    const next = applyDrop(
      state('a:g', 'b:g', 'c'),
      { kind: 'workspace', id: 'a' },
      { kind: 'end' },
    )
    expect(layout(next)).toEqual(['b:g', 'c', 'a'])
  })

  it('unpins a pinned workspace that joins a group, and keeps ungrouped drops below pinned ones', () => {
    const g = state('p*', 'a', 'b:g')
    expect(
      layout(
        applyDrop(
          g,
          { kind: 'workspace', id: 'p' },
          { kind: 'workspace', id: 'b', place: 'after' },
        ),
      ),
    ).toEqual(['a', 'b:g', 'p:g'])
    expect(
      layout(
        applyDrop(
          g,
          { kind: 'workspace', id: 'b' },
          { kind: 'workspace', id: 'p', place: 'before' },
        ),
      ),
    ).toEqual(['p*', 'b', 'a'])
  })

  it('reorders whole groups before or after another block', () => {
    const g = state('a', 'b:g', 'c:g', 'd:h')
    expect(
      layout(applyDrop(g, { kind: 'group', id: 'h' }, { kind: 'group', id: 'g', place: 'before' })),
    ).toEqual(['a', 'd:h', 'b:g', 'c:g'])
    expect(
      layout(
        applyDrop(g, { kind: 'group', id: 'g' }, { kind: 'workspace', id: 'a', place: 'before' }),
      ),
    ).toEqual(['b:g', 'c:g', 'a', 'd:h'])
    const moved = applyDrop(
      g,
      { kind: 'group', id: 'g' },
      { kind: 'workspace', id: 'd', place: 'after' },
    )
    expect(layout(moved)).toEqual(['a', 'd:h', 'b:g', 'c:g'])
    expect(groupIds(moved)).toEqual(['h', 'g'])
  })

  it('returns the same state for a no-op drop', () => {
    const g = state('a', 'b:g')
    expect(
      applyDrop(g, { kind: 'workspace', id: 'a' }, { kind: 'workspace', id: 'a', place: 'after' }),
    ).toBe(g)
    expect(
      applyDrop(g, { kind: 'group', id: 'g' }, { kind: 'workspace', id: 'b', place: 'before' }),
    ).toBe(g)
    expect(
      applyDrop(g, { kind: 'workspace', id: 'b' }, { kind: 'group', id: 'g', place: 'inside' }),
    ).toBe(g)
  })
})

describe('group membership', () => {
  it('creates a group around one workspace, unpinning it', () => {
    const next = createGroup(state('p*', 'a'), 'p', group('g'))
    expect(layout(next)).toEqual(['p:g', 'a'])
    expect(groupIds(next)).toEqual(['g'])
  })

  it('joins a group as its last member', () => {
    expect(layout(joinGroup(state('a', 'b:g', 'c'), 'c', 'g'))).toEqual(['a', 'b:g', 'c:g'])
  })

  it('leaves a group to just below it', () => {
    expect(layout(leaveGroup(state('a:g', 'b:g', 'c'), 'a'))).toEqual(['b:g', 'a', 'c'])
  })

  it('deletes a group but keeps every member, ungrouped', () => {
    const next = deleteGroup(state('a:g', 'b:g', 'c'), 'g')
    expect(layout(next)).toEqual(['a', 'b', 'c'])
    expect(next.groups).toEqual([])
  })

  it('pinning a grouped workspace takes it out of the group', () => {
    expect(layout(pinWorkspace(state('a', 'b:g'), 'b', true))).toEqual(['b*', 'a'])
  })

  it('renames, recolors and collapses a group', () => {
    const g = state('a:g')
    const next = patchGroup(g, 'g', { name: 'api', color: 'blue', collapsed: true })
    expect(next.groups).toEqual([{ id: 'g', name: 'api', color: 'blue', collapsed: true }])
    expect(patchGroup(next, 'g', { color: null, collapsed: false }).groups).toEqual([
      { id: 'g', name: 'api' },
    ])
  })

  it('inserts a new grouped workspace right after the anchor, or at the group’s end', () => {
    const g = state('a:g', 'b:g', 'c')
    expect(layout(insertWorkspace(g, parse('n:g'), 'a'))).toEqual(['a:g', 'n:g', 'b:g', 'c'])
    expect(layout(insertWorkspace(g, parse('n:g')))).toEqual(['a:g', 'b:g', 'n:g', 'c'])
    expect(layout(insertWorkspace(g, parse('n')))).toEqual(['a:g', 'b:g', 'c', 'n'])
  })
})

describe('matchGroupRule', () => {
  const rules = [
    { pattern: '~/work/*', group: 'work' },
    { pattern: '/srv/**', group: 'servers' },
    { pattern: '/tmp/scratch-?', group: 'scratch' },
  ]

  it('matches * within one folder, ** across folders and ? one character', () => {
    expect(matchGroupRule(rules, '~/work/api')).toBe('work')
    expect(matchGroupRule(rules, '~/work/api/sub')).toBeNull()
    expect(matchGroupRule(rules, '/srv/a/b/c/')).toBe('servers')
    expect(matchGroupRule(rules, '/tmp/scratch-1')).toBe('scratch')
    expect(matchGroupRule(rules, '/tmp/scratch-12')).toBeNull()
  })

  it('treats regex characters in a pattern literally', () => {
    expect(matchGroupRule([{ pattern: '/a+b/(x)', group: 'g' }], '/a+b/(x)')).toBe('g')
    expect(matchGroupRule([{ pattern: '/a+b', group: 'g' }], '/aab')).toBeNull()
  })

  it('uses the first matching rule', () => {
    expect(
      matchGroupRule(
        [
          { pattern: '/x/**', group: 'first' },
          { pattern: '/x/y', group: 'second' },
        ],
        '/x/y',
      ),
    ).toBe('first')
  })
})
