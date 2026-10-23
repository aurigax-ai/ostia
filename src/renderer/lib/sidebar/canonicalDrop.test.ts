import { describe, expect, it } from 'vitest'
import { canonicalDrop } from './canonicalDrop'
import type { Groupable, Grouping, WorkspaceGroup } from './workspaceGroups'

const rail = (groups: WorkspaceGroup[], ...workspaces: Groupable[]): Grouping<Groupable> => ({
  workspaces,
  groups,
})

const g = rail(
  [
    { id: 'g1', name: 'G1' },
    { id: 'g2', name: 'G2', collapsed: true },
  ],
  { id: 'pin', pinned: true },
  { id: 'a' },
  { id: 'b' },
  { id: 'm1', groupId: 'g1' },
  { id: 'm2', groupId: 'g1' },
  { id: 'c2', groupId: 'g2' },
  { id: 'z' },
)

const ws = (id: string) => ({ kind: 'workspace', id }) as const
const grp = (id: string) => ({ kind: 'group', id }) as const

describe('canonicalDrop', () => {
  it('marks nothing for a drop that leaves the rail as it is', () => {
    expect(canonicalDrop(g, ws('a'), { kind: 'workspace', id: 'a', place: 'after' })).toBeNull()
    expect(canonicalDrop(g, ws('a'), { kind: 'workspace', id: 'b', place: 'before' })).toBeNull()
    expect(canonicalDrop(g, grp('g1'), { kind: 'workspace', id: 'm2', place: 'after' })).toBeNull()
  })

  it('gives one target for both edges of the same gap', () => {
    const below = canonicalDrop(g, ws('z'), { kind: 'workspace', id: 'a', place: 'after' })
    const above = canonicalDrop(g, ws('z'), { kind: 'workspace', id: 'b', place: 'before' })
    expect(below).toEqual({ kind: 'workspace', id: 'b', place: 'before' })
    expect(above).toEqual(below)
  })

  it('marks the first unpinned row when an unpinned row is dropped among the pinned ones', () => {
    expect(canonicalDrop(g, ws('z'), { kind: 'workspace', id: 'pin', place: 'before' })).toEqual({
      kind: 'workspace',
      id: 'a',
      place: 'before',
    })
  })

  it('marks the edge of the group a dragged group lands beside, never a gap between its members', () => {
    expect(canonicalDrop(g, grp('g2'), { kind: 'workspace', id: 'm2', place: 'before' })).toEqual({
      kind: 'group',
      id: 'g1',
      place: 'before',
    })
  })

  it('marks inside a group under its last member, and the header of a collapsed group', () => {
    expect(canonicalDrop(g, ws('a'), { kind: 'workspace', id: 'm2', place: 'after' })).toEqual({
      kind: 'workspace',
      id: 'm2',
      place: 'after',
    })
    expect(canonicalDrop(g, ws('a'), { kind: 'group', id: 'g2', place: 'inside' })).toEqual({
      kind: 'group',
      id: 'g2',
      place: 'inside',
    })
  })

  it('marks under the last row for a drop at the bottom, and the end when a group ends the rail', () => {
    expect(canonicalDrop(g, ws('a'), { kind: 'end' })).toEqual({
      kind: 'workspace',
      id: 'z',
      place: 'after',
    })
    const endsInGroup = rail(g.groups, { id: 'a' }, { id: 'm1', groupId: 'g1' })
    expect(canonicalDrop(endsInGroup, ws('a'), { kind: 'end' })).toEqual({ kind: 'end' })
  })
})
