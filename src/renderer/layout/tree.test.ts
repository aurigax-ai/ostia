import { beforeEach, describe, expect, it } from 'vitest'
import {
  closePane,
  createPane,
  findPane,
  firstPaneId,
  firstPaneOfKind,
  movePane,
  paneIds,
  resetIds,
  setPaneCwd,
  setPaneEditor,
  setSizes,
  splitOf,
  splitPane,
} from './tree'
import type { LayoutNode } from './types'

beforeEach(() => resetIds())

/** Compact a child to its pane id, or the marker `'split'` for internal nodes. */
const idOf = (n: LayoutNode): string => (n.type === 'pane' ? n.id : 'split')

describe('splitPane', () => {
  it('wraps a lone root pane into a split with two panes', () => {
    const root = createPane()
    const { root: next, newPaneId } = splitPane(root, root.id, 'horizontal')
    expect(next.type).toBe('split')
    expect(paneIds(next)).toHaveLength(2)
    expect(newPaneId).not.toBeNull()
    expect(paneIds(next)).toContain(newPaneId)
  })

  it('inserts a sibling when the parent runs the same direction', () => {
    const root = createPane()
    const a = splitPane(root, root.id, 'horizontal').root // split[p, p]
    const b = splitPane(a, firstPaneId(a), 'horizontal').root // same axis -> 3 siblings
    expect(b.type).toBe('split')
    if (b.type === 'split') {
      expect(b.children.every((c) => c.type === 'pane')).toBe(true)
      expect(b.children).toHaveLength(3)
      expect(b.sizes).toHaveLength(3)
    }
  })

  it('nests a new split when the direction differs', () => {
    const root = createPane()
    const a = splitPane(root, root.id, 'horizontal').root
    const b = splitPane(a, firstPaneId(a), 'vertical').root // cross axis -> nested split
    expect(b.type).toBe('split')
    if (b.type === 'split') {
      expect(b.children[0].type).toBe('split')
      expect(paneIds(b)).toHaveLength(3)
    }
  })

  it('returns the tree unchanged for an unknown target', () => {
    const root = createPane()
    const { root: next, newPaneId } = splitPane(root, 'nope', 'horizontal')
    expect(next).toBe(root)
    expect(newPaneId).toBeNull()
  })
})

describe('closePane', () => {
  it('collapses a split back to a single pane when one child remains', () => {
    const root = createPane()
    const { root: split, newPaneId } = splitPane(root, root.id, 'horizontal')
    const closed = closePane(split, newPaneId as string)
    expect(closed.type).toBe('pane')
    expect(paneIds(closed)).toHaveLength(1)
  })

  it('never removes the last pane', () => {
    const root = createPane()
    expect(closePane(root, root.id)).toBe(root)
  })

  it('prunes nested splits and collapses upward', () => {
    const root = createPane()
    const a = splitPane(root, root.id, 'horizontal').root
    const { root: b, newPaneId } = splitPane(a, firstPaneId(a), 'vertical') // nested
    expect(paneIds(b)).toHaveLength(3)
    const c = closePane(b, newPaneId as string) // remove nested sibling
    expect(paneIds(c)).toHaveLength(2)
    expect(c.type).toBe('split')
    if (c.type === 'split') {
      expect(c.children.every((ch) => ch.type === 'pane')).toBe(true)
    }
  })
})

describe('movePane', () => {
  it('is a no-op when dropping a pane on itself', () => {
    const root = createPane()
    const split = splitPane(root, root.id, 'horizontal').root
    const id = firstPaneId(split)
    expect(movePane(split, id, id, 'right')).toBe(split)
  })

  it('re-splits along the dropped edge (horizontal → vertical)', () => {
    const root = createPane()
    const { root: split, newPaneId } = splitPane(root, root.id, 'horizontal')
    const firstId = firstPaneId(split)
    // Move the new pane to the bottom of the first → a vertical split [first, new].
    const moved = movePane(split, newPaneId as string, firstId, 'bottom')
    expect(moved.type).toBe('split')
    if (moved.type === 'split') {
      expect(moved.direction).toBe('vertical')
      expect(moved.children.map((c) => (c.type === 'pane' ? c.id : 'split'))).toEqual([
        firstId,
        newPaneId,
      ])
    }
    expect(paneIds(moved)).toHaveLength(2)
  })

  it('swaps two panes on a center drop', () => {
    const root = createPane()
    const { root: split, newPaneId } = splitPane(root, root.id, 'horizontal')
    const firstId = firstPaneId(split)
    const moved = movePane(split, firstId, newPaneId as string, 'center')
    expect(moved.type).toBe('split')
    if (moved.type === 'split') {
      expect(moved.children.map((c) => (c.type === 'pane' ? c.id : 'split'))).toEqual([
        newPaneId,
        firstId,
      ])
    }
  })

  it('keeps every pane when relocating within a 3-pane tree', () => {
    const root = createPane()
    const a = splitPane(root, root.id, 'horizontal').root
    const { root: b } = splitPane(a, firstPaneId(a), 'vertical') // 3 panes, nested
    const ids = paneIds(b)
    const moved = movePane(b, ids[2], ids[0], 'right')
    expect(paneIds(moved).sort()).toEqual([...ids].sort())
  })
})

describe('splitOf', () => {
  it('builds a split with the given direction, children, and unit sizes', () => {
    const a = createPane()
    const b = createPane()
    const split = splitOf('vertical', a, b)
    expect(split.type).toBe('split')
    expect(split.direction).toBe('vertical')
    expect(split.children).toEqual([a, b])
    expect(split.sizes).toEqual([1, 1])
    expect(split.id).toMatch(/^split-/)
  })
})

describe('setPaneCwd', () => {
  it('sets cwd on the matching leaf, leaving siblings untouched', () => {
    const a = createPane()
    const b = createPane()
    const root = splitOf('horizontal', a, b)
    const next = setPaneCwd(root, b.id, '/work/api')
    expect(findPane(next, b.id)?.cwd).toBe('/work/api')
    expect(findPane(next, a.id)?.cwd).toBeUndefined()
  })

  it('sets cwd when the root pane itself matches', () => {
    const root = createPane()
    const next = setPaneCwd(root, root.id, '/home')
    expect(next).not.toBe(root)
    expect(findPane(next, root.id)?.cwd).toBe('/home')
  })

  it('returns the same lone root pane when the id does not match', () => {
    const root = createPane()
    expect(setPaneCwd(root, 'ghost', '/x')).toBe(root)
  })
})

describe('firstPaneOfKind', () => {
  it('returns the first pane of the kind in tree order, descending into splits', () => {
    const t1 = createPane('terminal')
    const e1 = createPane('editor')
    const e2 = createPane('editor')
    const root = splitOf('horizontal', t1, splitOf('vertical', e1, e2))
    expect(firstPaneOfKind(root, 'editor')).toBe(e1)
  })

  it('returns the root pane when it matches the kind', () => {
    const root = createPane('agent')
    expect(firstPaneOfKind(root, 'agent')).toBe(root)
  })

  it('returns null when no pane has the kind', () => {
    const root = splitOf('horizontal', createPane('terminal'), createPane('terminal'))
    expect(firstPaneOfKind(root, 'browser')).toBeNull()
  })
})

describe('setPaneEditor', () => {
  it('turns the matching pane into an editor and derives cwd from the file dir', () => {
    const a = createPane('terminal')
    const b = createPane('terminal')
    const root = splitOf('horizontal', a, b)
    const next = setPaneEditor(root, b.id, 'main.ts', '/src/app/main.ts')
    const pane = findPane(next, b.id)
    expect(pane?.kind).toBe('editor')
    expect(pane?.title).toBe('main.ts')
    expect(pane?.filePath).toBe('/src/app/main.ts')
    expect(pane?.cwd).toBe('/src/app')
    expect(findPane(next, a.id)?.kind).toBe('terminal')
  })

  it('falls back to root cwd for a file at the filesystem root', () => {
    const root = createPane('terminal')
    const next = setPaneEditor(root, root.id, 'notes.txt', '/notes.txt')
    const pane = findPane(next, root.id)
    expect(pane?.kind).toBe('editor')
    expect(pane?.cwd).toBe('/')
  })

  it('leaves a non-matching lone pane unchanged', () => {
    const root = createPane('terminal')
    expect(setPaneEditor(root, 'ghost', 't', '/a/t.ts')).toBe(root)
  })
})

describe('setSizes', () => {
  it('replaces the sizes of a nested split addressed by id', () => {
    const a = createPane()
    const b = createPane()
    const inner = splitOf('vertical', a, b)
    const root = splitOf('horizontal', createPane(), inner)
    const next = setSizes(root, inner.id, [0.3, 0.7])
    expect(next.type).toBe('split')
    if (next.type === 'split') {
      const innerNext = next.children[1]
      expect(innerNext.type).toBe('split')
      if (innerNext.type === 'split') expect(innerNext.sizes).toEqual([0.3, 0.7])
    }
  })

  it('updates the root split when its own id matches', () => {
    const root = splitOf('horizontal', createPane(), createPane())
    const next = setSizes(root, root.id, [2, 5])
    expect(next.type).toBe('split')
    if (next.type === 'split') expect(next.sizes).toEqual([2, 5])
  })

  it('leaves sizes unchanged when no split id matches', () => {
    const root = splitOf('horizontal', createPane(), createPane())
    const next = setSizes(root, 'ghost', [9, 9])
    expect(next.type).toBe('split')
    if (next.type === 'split') expect(next.sizes).toEqual([1, 1])
  })

  it('returns a lone root pane unchanged', () => {
    const root = createPane()
    expect(setSizes(root, 'any', [1])).toBe(root)
  })
})

describe('splitPane (deeper trees)', () => {
  it('splits a pane nested inside a child split, adding a same-axis sibling there', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    const root = splitOf('horizontal', a, splitOf('vertical', b, c))
    const { root: next, newPaneId } = splitPane(root, c.id, 'vertical')
    expect(newPaneId).not.toBeNull()
    expect(paneIds(next)).toHaveLength(4)
    expect(next.type).toBe('split')
    if (next.type === 'split') {
      const inner = next.children[1]
      expect(inner.type).toBe('split')
      if (inner.type === 'split') {
        expect(inner.children).toHaveLength(3)
        expect(inner.sizes).toHaveLength(3)
        expect(paneIds(inner)).toContain(newPaneId)
      }
    }
  })

  it('returns null (and adds no pane) for an unknown target inside a split root', () => {
    const root = splitOf(
      'horizontal',
      createPane(),
      splitOf('vertical', createPane(), createPane()),
    )
    const { root: next, newPaneId } = splitPane(root, 'ghost', 'horizontal')
    expect(newPaneId).toBeNull()
    expect(paneIds(next)).toEqual(paneIds(root))
    expect(paneIds(next)).toHaveLength(3)
  })
})

describe('movePane (edge zones on wider trees)', () => {
  it('re-inserts as a same-axis sibling after the target (right onto a row)', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    const root = splitOf('horizontal', a, b, c)
    const moved = movePane(root, c.id, a.id, 'right')
    expect(moved.type).toBe('split')
    if (moved.type === 'split') {
      expect(moved.direction).toBe('horizontal')
      expect(moved.children.map(idOf)).toEqual([a.id, c.id, b.id])
      expect(moved.children).toHaveLength(3)
      expect(moved.sizes).toHaveLength(3)
    }
    expect(paneIds(moved)).toHaveLength(3)
  })

  it('re-inserts as a same-axis sibling before the target (left onto a row)', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    const root = splitOf('horizontal', a, b, c)
    const moved = movePane(root, c.id, b.id, 'left')
    expect(moved.type).toBe('split')
    if (moved.type === 'split') expect(moved.children.map(idOf)).toEqual([a.id, c.id, b.id])
  })

  it('re-splits the target on a cross axis, placing the source before it (top drop)', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    const root = splitOf('horizontal', a, b, c)
    const moved = movePane(root, c.id, a.id, 'top')
    expect(moved.type).toBe('split')
    if (moved.type === 'split') {
      const first = moved.children[0]
      expect(first.type).toBe('split')
      if (first.type === 'split') {
        expect(first.direction).toBe('vertical')
        expect(first.children.map(idOf)).toEqual([c.id, a.id])
      }
    }
    expect(paneIds(moved).sort()).toEqual([a.id, b.id, c.id].sort())
  })

  it('descends into a nested subtree to reach a deeply-nested target (right drop)', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    const d = createPane()
    const root = splitOf('horizontal', splitOf('vertical', a, b), splitOf('vertical', c, d))
    const moved = movePane(root, a.id, c.id, 'right')
    expect(paneIds(moved).sort()).toEqual([a.id, b.id, c.id, d.id].sort())
    expect(moved.type).toBe('split')
    if (moved.type === 'split') {
      expect(moved.children.map(idOf)).toEqual([b.id, 'split'])
      const rhs = moved.children[1]
      if (rhs.type === 'split') {
        const nested = rhs.children[0]
        expect(nested.type).toBe('split')
        if (nested.type === 'split') expect(nested.children.map(idOf)).toEqual([c.id, a.id])
      }
    }
  })

  it('swaps two panes on a center drop while leaving a third pane in place', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    const root = splitOf('horizontal', a, b, c)
    const moved = movePane(root, a.id, c.id, 'center')
    expect(moved.type).toBe('split')
    if (moved.type === 'split') expect(moved.children.map(idOf)).toEqual([c.id, b.id, a.id])
    expect(paneIds(moved)).toHaveLength(3)
  })

  it('collapses a 2-pane split and re-inserts the source before the target (left drop)', () => {
    const a = createPane()
    const b = createPane()
    const root = splitOf('horizontal', a, b)
    const moved = movePane(root, b.id, a.id, 'left')
    expect(moved.type).toBe('split')
    if (moved.type === 'split') {
      expect(moved.direction).toBe('horizontal')
      expect(moved.children.map(idOf)).toEqual([b.id, a.id])
    }
    expect(paneIds(moved)).toHaveLength(2)
  })

  it('is a no-op when the source pane id is unknown', () => {
    const root = splitOf('horizontal', createPane(), createPane())
    expect(movePane(root, 'ghost', firstPaneId(root), 'right')).toBe(root)
  })

  it('is a no-op when the target pane id is unknown', () => {
    const root = splitOf('horizontal', createPane(), createPane())
    expect(movePane(root, firstPaneId(root), 'ghost', 'left')).toBe(root)
  })
})

// Defensive `?? 1` / empty-split guards are reachable only through a malformed
// tree (a sizes array out of sync with children, or a childless split), which
// `setSizes`/`splitOf` let us construct. These document that the transforms stay
// robust instead of crashing.
//
// Three guard branches remain genuinely unreachable via the public API:
//  - insertSibling `root.id !== targetId` (tree.ts:188) and swapPanes `!a || !b`
//    (tree.ts:220): both sit behind movePane's source/target existence checks.
//  - insertSibling's `sizes[idx] ?? 1` (tree.ts:198): movePane always runs
//    closePane first, which rebuilds every split's sizes to exactly one entry per
//    kept child, so insertSibling never receives a short sizes array.
describe('malformed-tree robustness (defensive guards)', () => {
  it('splitPane tolerates a too-short sizes array, keeping sizes aligned to children', () => {
    const a = createPane()
    const b = createPane()
    let root: LayoutNode = splitOf('horizontal', a, b)
    root = setSizes(root, root.id, [1]) // drop b's size entry → sizes[idx] is undefined
    const { root: next, newPaneId } = splitPane(root, b.id, 'horizontal')
    expect(newPaneId).not.toBeNull()
    expect(next.type).toBe('split')
    if (next.type === 'split') {
      expect(next.children).toHaveLength(3)
      expect(next.sizes).toHaveLength(next.children.length)
      expect(next.sizes.every((s) => s > 0)).toBe(true)
    }
  })

  it('closePane tolerates a too-short sizes array, pruning with aligned sizes', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    let root: LayoutNode = splitOf('horizontal', a, b, c)
    root = setSizes(root, root.id, [1, 1]) // drop c's size entry → sizes[i] is undefined
    const closed = closePane(root, a.id)
    expect(closed.type).toBe('split')
    if (closed.type === 'split') {
      expect(paneIds(closed)).toEqual([b.id, c.id])
      expect(closed.sizes).toHaveLength(closed.children.length)
      expect(closed.sizes.every((s) => s > 0)).toBe(true)
    }
  })

  it('closePane returns a childless split unchanged (nothing to prune)', () => {
    const empty = splitOf('horizontal')
    const res = closePane(empty, 'ghost')
    expect(res).toBe(empty)
    expect(res.type).toBe('split')
    if (res.type === 'split') expect(res.children).toHaveLength(0)
  })
})
