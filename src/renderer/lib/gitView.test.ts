import type { BranchRef, GitGraphData, GraphCommit } from '@shared/git'
import { describe, expect, it } from 'vitest'
import {
  clampPosition,
  fractionOf,
  keyPosition,
  percentOf,
  splitBasis,
  splitBounds,
} from './gitSplit'
import {
  ROW_HEIGHT,
  WORKTREE,
  branchLabel,
  buildGraphModel,
  edgePath,
  entryKey,
  failureText,
  indexOfKey,
  leaves,
  matchingBranches,
  relativeTime,
  scrollTopToShow,
  selectionTarget,
  splitPath,
  toggledRefs,
  visibleRange,
} from './gitView'

function commit(sha: string, parents: string[]): GraphCommit {
  return { sha, parents, author: 'Ada', email: 'a@b.c', time: 0, subject: sha, refs: [] }
}

function graph(patch: Partial<GitGraphData> = {}): GitGraphData {
  return {
    root: '/repo',
    branch: { oid: 'a', head: 'main', upstream: null, ahead: 0, behind: 0 },
    counts: { added: 0, changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    changes: [],
    branches: [],
    scope: { kind: 'current' },
    includesHead: true,
    commits: [commit('a', ['b']), commit('b', [])],
    more: false,
    ...patch,
  }
}

function branch(name: string, remote = false): BranchRef {
  return { ref: `refs/${name}`, name, remote, current: false, sha: name, time: 0 }
}

describe('buildGraphModel', () => {
  it('lists the commits alone in a clean repository', () => {
    const model = buildGraphModel(graph())
    expect(model.entries.map(entryKey)).toEqual(['a', 'b'])
    expect(model.rows).toHaveLength(2)
    expect(model.width).toBe(30)
  })

  it('puts a pending row above HEAD when there are changes', () => {
    const model = buildGraphModel(
      graph({ changes: [{ path: 'a.txt', area: 'unstaged', code: 'M' }] }),
    )
    expect(model.entries.map(entryKey)).toEqual([WORKTREE, 'a', 'b'])
    expect(model.rows[0].bottom).toEqual([{ from: 0, to: 0, color: 0, pending: true }])
    expect(indexOfKey(model, 'b')).toBe(2)
    expect(indexOfKey(model, null)).toBe(-1)
    expect(indexOfKey(model, 'zzz')).toBe(-1)
  })

  it('leaves the pending row unattached when the scope does not include HEAD', () => {
    const model = buildGraphModel(
      graph({ includesHead: false, changes: [{ path: 'a.txt', area: 'staged', code: 'A' }] }),
    )
    expect(model.rows[0].bottom).toEqual([])
  })

  it('draws at most twelve lanes however wide the history is', () => {
    const tips = Array.from({ length: 20 }, (_, i) => commit(`t${i}`, [`p${i}`]))
    const roots = Array.from({ length: 20 }, (_, i) => commit(`p${i}`, []))
    const model = buildGraphModel(graph({ commits: [...tips, ...roots] }))
    expect(Math.max(...model.rows.map((r) => r.width))).toBe(20)
    expect(model.width).toBe(8 * 2 + 12 * 14)
  })
})

describe('graph window', () => {
  it('paints the visible rows plus the overscan', () => {
    expect(visibleRange(0, 240, 1000)).toEqual({ first: 0, last: 26 })
    expect(visibleRange(100 * ROW_HEIGHT, 240, 1000)).toEqual({ first: 92, last: 118 })
    expect(visibleRange(990 * ROW_HEIGHT, 240, 1000)).toEqual({ first: 982, last: 1000 })
  })

  it('assumes twenty rows before the list has been measured', () => {
    expect(visibleRange(0, 0, 1000)).toEqual({ first: 0, last: 36 })
  })

  it('never starts past the end of a list that shrank', () => {
    expect(visibleRange(500 * ROW_HEIGHT, 240, 10)).toEqual({ first: 10, last: 10 })
  })

  it('moves the selection by row, by page and to the ends, inside the list', () => {
    expect(selectionTarget('ArrowDown', -1, 10, 240)).toBe(0)
    expect(selectionTarget('ArrowUp', -1, 10, 240)).toBe(0)
    expect(selectionTarget('ArrowDown', 9, 10, 240)).toBe(9)
    expect(selectionTarget('PageDown', 2, 100, 240)).toBe(11)
    expect(selectionTarget('PageUp', 2, 100, 240)).toBe(0)
    expect(selectionTarget('End', 2, 100, 240)).toBe(99)
    expect(selectionTarget('Home', 50, 100, 240)).toBe(0)
  })

  it('scrolls only as far as needed to show a row', () => {
    expect(scrollTopToShow(5, 0, 240)).toBe(0)
    expect(scrollTopToShow(2, 120, 240)).toBe(48)
    expect(scrollTopToShow(20, 0, 240)).toBe(264)
  })

  it('draws a straight edge in one lane and a curve between two', () => {
    expect(edgePath({ from: 0, to: 0, color: 0 }, 0, 12)).toBe('M15 0V12')
    expect(edgePath({ from: 0, to: 1, color: 0 }, 12, 24)).toBe('M15 12C15 24 29 12 29 24')
  })
})

describe('git view text', () => {
  it('splits a path into its name and folder', () => {
    expect(splitPath('src/deep/a.ts')).toEqual({ name: 'a.ts', dir: 'src/deep' })
    expect(splitPath('a.ts')).toEqual({ name: 'a.ts', dir: '' })
  })

  it('names a detached HEAD by its short sha', () => {
    const detached = { oid: '0123456789abcdef', head: null, upstream: null, ahead: 0, behind: 0 }
    expect(branchLabel(detached, 'detached')).toBe('0123456 (detached)')
    expect(branchLabel({ ...detached, head: 'main' }, 'detached')).toBe('main')
  })

  it('prefers the message of a failure over its code', () => {
    expect(failureText({ ok: false, error: 'git-failed', message: 'fatal: no' })).toBe('fatal: no')
    expect(failureText({ ok: false, error: 'git-failed' })).toBe('git-failed')
  })

  it('tells how long ago a commit was made', () => {
    const now = 1_700_000_000_000
    expect(relativeTime(1_700_000_000 - 7200, now, 'en')).toBe('2 hours ago')
    expect(relativeTime(1_700_000_000 - 86_400, now, 'en')).toBe('yesterday')
  })

  it('collects every file under a folder', () => {
    expect(
      leaves({
        kind: 'folder',
        name: 'src',
        path: 'src',
        count: 2,
        children: [
          { kind: 'file', name: 'a', path: 'src/a', item: 'A' },
          {
            kind: 'folder',
            name: 'deep',
            path: 'src/deep',
            count: 1,
            children: [{ kind: 'file', name: 'b', path: 'src/deep/b', item: 'B' }],
          },
        ],
      }),
    ).toEqual(['A', 'B'])
  })

  it('filters branches by a case-insensitive part of the name', () => {
    const all = [branch('main'), branch('Feature/Login'), branch('origin/main', true)]
    expect(matchingBranches(all, ' MAIN ').map((b) => b.name)).toEqual(['main', 'origin/main'])
    expect(matchingBranches(all, '')).toBe(all)
  })

  it('adds a branch that is not chosen and drops one that is', () => {
    expect(toggledRefs(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggledRefs(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('split maths', () => {
  it('keeps both panes at their minimum and collapses when there is no room for both', () => {
    expect(splitBounds(400, 96, 96)).toEqual({ min: 96, max: 304, collapsed: false })
    expect(splitBounds(150, 96, 96)).toEqual({ min: 54, max: 54, collapsed: true })
  })

  it('clamps a dragged position and turns it into a fraction', () => {
    const bounds = splitBounds(400, 96, 96)
    expect(clampPosition(10, bounds)).toBe(96)
    expect(clampPosition(399, bounds)).toBe(304)
    expect(fractionOf(200, 400, bounds)).toBe(0.5)
    expect(fractionOf(200, 0, bounds)).toBe(0)
  })

  it('steps with the arrow and page keys and jumps with Home and End', () => {
    const bounds = splitBounds(400, 96, 96)
    expect(keyPosition('ArrowUp', 200, bounds)).toBe(184)
    expect(keyPosition('ArrowDown', 300, bounds)).toBe(304)
    expect(keyPosition('PageUp', 200, bounds)).toBe(136)
    expect(keyPosition('Home', 200, bounds)).toBe(96)
    expect(keyPosition('End', 200, bounds)).toBe(304)
    expect(keyPosition('a', 200, bounds)).toBeNull()
  })

  it('reports the position as a whole percentage', () => {
    expect(percentOf(100, 400)).toBe(25)
    expect(percentOf(100, 0)).toBe(0)
  })

  it('sizes the first pane between the two minimums', () => {
    expect(splitBasis(0.55, 96, 72)).toBe('clamp(96px, 55.00000000000001%, calc(100% - 72px))')
  })
})
