import type { FileChange } from '@shared/boards/git'
import { describe, expect, it } from 'vitest'
import { neighborChange, orderedChanges } from './changeNeighbor'

const CHANGES: FileChange[] = [
  { path: 'u.txt', area: 'untracked', code: '?' },
  { path: 'b.ts', area: 'unstaged', code: 'M' },
  { path: 'a.ts', area: 'staged', code: 'M' },
  { path: 'a.ts', area: 'unstaged', code: 'M' },
]

describe('orderedChanges', () => {
  it('lists changes in the Git panel order with absolute paths', () => {
    expect(orderedChanges('/r', CHANGES).map((c) => `${c.area}:${c.path}`)).toEqual([
      'staged:/r/a.ts',
      'unstaged:/r/b.ts',
      'unstaged:/r/a.ts',
      'untracked:/r/u.txt',
    ])
  })
})

describe('neighborChange', () => {
  const list = orderedChanges('/r', CHANGES)

  it('steps to the next and previous entry', () => {
    expect(neighborChange(list, { path: '/r/b.ts', area: 'unstaged' }, 1)).toEqual({
      path: '/r/a.ts',
      area: 'unstaged',
    })
    expect(neighborChange(list, { path: '/r/b.ts', area: 'unstaged' }, -1)).toEqual({
      path: '/r/a.ts',
      area: 'staged',
    })
  })

  it('tells a path staged and unstaged apart by its area', () => {
    expect(neighborChange(list, { path: '/r/a.ts', area: 'unstaged' }, 1)).toEqual({
      path: '/r/u.txt',
      area: 'untracked',
    })
    expect(neighborChange(list, { path: '/r/a.ts', area: 'staged' }, 1)).toEqual({
      path: '/r/b.ts',
      area: 'unstaged',
    })
  })

  it('wraps around at both ends', () => {
    expect(neighborChange(list, { path: '/r/u.txt', area: 'untracked' }, 1)?.path).toBe('/r/a.ts')
    expect(neighborChange(list, { path: '/r/a.ts', area: 'staged' }, -1)?.path).toBe('/r/u.txt')
  })

  it('has no neighbour for a file outside the list or a single change', () => {
    expect(neighborChange(list, { path: '/r/x.ts', area: 'staged' }, 1)).toBeNull()
    expect(neighborChange([list[0]], list[0], 1)).toBeNull()
  })
})
