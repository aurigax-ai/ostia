import { beforeEach, describe, expect, it } from 'vitest'
import {
  addTab,
  adoptIds,
  allPanes,
  closePane,
  createPane,
  findExtensionPane,
  findPane,
  firstPaneId,
  firstPaneOfKind,
  isPaneShown,
  movePane,
  paneIds,
  resetIds,
  selectTab,
  setPaneBrowser,
  setPaneCwd,
  setPaneDiff,
  setPaneEditor,
  setPaneExtension,
  setPaneHibernated,
  setPaneUrl,
  setSizes,
  splitOf,
  splitPane,
  tabsOf,
  tabsOfPane,
  withoutKind,
} from './tree'
import type { LayoutNode } from './types'

beforeEach(() => resetIds())

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
    const a = splitPane(root, root.id, 'horizontal').root
    const b = splitPane(a, firstPaneId(a), 'horizontal').root
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
    const b = splitPane(a, firstPaneId(a), 'vertical').root
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
    const { root: b, newPaneId } = splitPane(a, firstPaneId(a), 'vertical')
    expect(paneIds(b)).toHaveLength(3)
    const c = closePane(b, newPaneId as string)
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

  it('merges the source into the target’s tabs on a center drop', () => {
    const root = createPane()
    const { root: split, newPaneId } = splitPane(root, root.id, 'horizontal')
    const firstId = firstPaneId(split)
    const moved = movePane(split, firstId, newPaneId as string, 'center')
    expect(moved).toMatchObject({ type: 'tabs', activeId: firstId })
    expect(paneIds(moved)).toEqual([newPaneId, firstId])
  })

  it('keeps every pane when relocating within a 3-pane tree', () => {
    const root = createPane()
    const a = splitPane(root, root.id, 'horizontal').root
    const { root: b } = splitPane(a, firstPaneId(a), 'vertical')
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

  it('returns the identical tree when the cwd is unchanged', () => {
    const a = createPane('terminal', undefined, '/work')
    const b = createPane('terminal', undefined, '/home')
    const root = splitOf('horizontal', a, splitOf('vertical', b, createPane()))
    expect(setPaneCwd(root, b.id, '/home')).toBe(root)
  })

  it('keeps untouched subtrees referentially identical when one cwd changes', () => {
    const a = createPane()
    const inner = splitOf('vertical', createPane(), createPane())
    const root = splitOf('horizontal', a, inner)
    const next = setPaneCwd(root, a.id, '/x')
    expect(next).not.toBe(root)
    expect(next.type === 'split' && next.children[1]).toBe(inner)
  })
})

describe('setPaneUrl', () => {
  it('updates the url of the matching pane and keeps its title', () => {
    const pane = createPane('browser', 'example.com')
    const root = splitOf('horizontal', createPane(), pane)
    const next = setPaneUrl(root, pane.id, 'https://example.com/next')
    expect(findPane(next, pane.id)?.url).toBe('https://example.com/next')
    expect(findPane(next, pane.id)?.title).toBe('example.com')
  })

  it('returns the identical tree when the url is unchanged', () => {
    const pane = { ...createPane('browser'), url: 'https://a.test/' }
    const root = splitOf('horizontal', createPane(), pane)
    expect(setPaneUrl(root, pane.id, 'https://a.test/')).toBe(root)
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

describe('allPanes', () => {
  it('returns just the root when it is a lone pane', () => {
    const root = createPane('terminal')
    expect(allPanes(root)).toEqual([root])
  })

  it('returns every leaf pane node, in tree order, descending into nested splits', () => {
    const t1 = createPane('terminal')
    const e1 = createPane('editor')
    const e2 = createPane('editor')
    const root = splitOf('horizontal', t1, splitOf('vertical', e1, e2))
    expect(allPanes(root)).toEqual([t1, e1, e2])
  })

  it("carries each pane node's own kind/title/cwd through untouched", () => {
    const a = createPane('terminal', 'zsh', '/work/api')
    const b = createPane('browser')
    const root = splitOf('horizontal', a, b)
    const panes = allPanes(root)
    expect(panes.map((p) => p.kind)).toEqual(['terminal', 'browser'])
    expect(panes[0].title).toBe('zsh')
    expect(panes[0].cwd).toBe('/work/api')
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

  it('falls back to root cwd for a bare file name with no slash', () => {
    const root = createPane('terminal')
    const pane = findPane(setPaneEditor(root, root.id, 'notes.txt', 'notes.txt'), root.id)
    expect(pane?.cwd).toBe('/')
  })

  it('leaves a non-matching lone pane unchanged', () => {
    const root = createPane('terminal')
    expect(setPaneEditor(root, 'ghost', 't', '/a/t.ts')).toBe(root)
  })
})

describe('setPaneBrowser', () => {
  it('turns the matching pane into a browser and derives the title from the URL host', () => {
    const a = createPane('terminal')
    const b = createPane('terminal')
    const root = splitOf('horizontal', a, b)
    const next = setPaneBrowser(root, b.id, 'https://example.com/path?q=1')
    const pane = findPane(next, b.id)
    expect(pane?.kind).toBe('browser')
    expect(pane?.url).toBe('https://example.com/path?q=1')
    expect(pane?.title).toBe('example.com')
    expect(findPane(next, a.id)?.kind).toBe('terminal')
  })

  it('falls back to the raw string as the title when the URL is unparseable', () => {
    const root = createPane('terminal')
    const next = setPaneBrowser(root, root.id, 'about:blank')
    const pane = findPane(next, root.id)
    expect(pane?.kind).toBe('browser')
    expect(pane?.url).toBe('about:blank')
    expect(pane?.title).toBe('about:blank')
  })

  it('leaves a non-matching lone pane unchanged', () => {
    const root = createPane('terminal')
    expect(setPaneBrowser(root, 'ghost', 'https://example.com')).toBe(root)
  })
})

describe('setPaneExtension', () => {
  it('turns the matching pane into an extension panel with the given id and title', () => {
    const a = createPane('terminal')
    const b = createPane('terminal', undefined, '/w')
    const root = splitOf('horizontal', a, b)
    const next = setPaneExtension(root, b.id, 'demo', 'Board')
    const pane = findPane(next, b.id)
    expect(pane?.kind).toBe('extension')
    expect(pane?.extensionId).toBe('demo')
    expect(pane?.title).toBe('Board')
    expect(pane?.cwd).toBeUndefined()
    expect(findPane(next, a.id)?.kind).toBe('terminal')
  })

  it('returns the same tree when no pane matches', () => {
    const root = splitOf('horizontal', createPane('terminal'), createPane('terminal'))
    expect(setPaneExtension(root, 'ghost', 'notes', 'Notes')).toBe(root)
  })
})

describe('setPaneDiff', () => {
  it('turns the pane into a diff surface, dropping fields of its previous surface', () => {
    const editor = { ...createPane('editor', 'a.ts', '/p'), filePath: '/p/a.ts' }
    const other = createPane()
    const root = splitOf('horizontal', editor, other)
    const next = setPaneDiff(root, editor.id, 'a.ts (diff)', '/repo')
    expect(findPane(next, editor.id)).toEqual({
      type: 'pane',
      id: editor.id,
      kind: 'diff',
      title: 'a.ts (diff)',
      cwd: '/repo',
    })
    expect(next.type === 'split' && next.children[1]).toBe(other)
  })
})

describe('withoutKind', () => {
  it('removes every pane of the kind and collapses single-child splits', () => {
    const a = createPane()
    const d1 = createPane('diff')
    const d2 = createPane('diff')
    const root = splitOf('horizontal', a, splitOf('vertical', d1, d2))
    expect(withoutKind(root, 'diff')).toBe(a)
  })

  it('returns the same object when nothing matches and null when everything does', () => {
    const root = splitOf('horizontal', createPane(), createPane())
    expect(withoutKind(root, 'diff')).toBe(root)
    expect(withoutKind(createPane('diff'), 'diff')).toBeNull()
  })

  it('keeps the sizes of the surviving children', () => {
    const a = createPane()
    const b = createPane()
    const root = { ...splitOf('horizontal', a, createPane('diff'), b), sizes: [2, 1, 3] }
    expect(withoutKind(root, 'diff')).toMatchObject({ sizes: [2, 3] })
  })
})

describe('findExtensionPane', () => {
  it('finds the panel pane of one extension and ignores other extensions', () => {
    const a = createPane('terminal')
    const b = createPane('terminal')
    const c = createPane('terminal')
    let root: LayoutNode = splitOf('horizontal', a, splitOf('vertical', b, c))
    root = setPaneExtension(root, b.id, 'notes', 'Notes')
    root = setPaneExtension(root, c.id, 'demo', 'Board')
    expect(findExtensionPane(root, 'demo')?.id).toBe(c.id)
    expect(findExtensionPane(root, 'git')).toBeNull()
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

  it('merges into the target’s tabs on a center drop while leaving a third pane in place', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    const root = splitOf('horizontal', a, b, c)
    const moved = movePane(root, a.id, c.id, 'center')
    expect(moved.type).toBe('split')
    if (moved.type === 'split') {
      expect(moved.children.map((n) => n.type)).toEqual(['pane', 'tabs'])
      expect(moved.children[1]).toMatchObject({ activeId: a.id })
    }
    expect(paneIds(moved)).toEqual([b.id, c.id, a.id])
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

describe('malformed-tree robustness (defensive guards)', () => {
  it('splitPane tolerates a too-short sizes array, keeping sizes aligned to children', () => {
    const a = createPane()
    const b = createPane()
    let root: LayoutNode = splitOf('horizontal', a, b)
    root = setSizes(root, root.id, [1])
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
    root = setSizes(root, root.id, [1, 1])
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

describe('adoptIds', () => {
  it('advances the counter past a restored id so the next pane cannot collide', () => {
    adoptIds({ type: 'pane', id: 'pane-7', title: 'zsh', kind: 'terminal' })
    expect(createPane().id).toBe('pane-8')
  })

  it('walks the whole tree, not just the root', () => {
    adoptIds(
      splitOf(
        'horizontal',
        { type: 'pane', id: 'pane-2', title: 'zsh', kind: 'terminal' },
        splitOf('vertical', { type: 'pane', id: 'pane-9', title: 'zsh', kind: 'terminal' }),
      ),
    )
    expect(createPane().id).toBe('pane-10')
  })

  it('counts split ids too — panes and splits share one counter', () => {
    adoptIds({
      type: 'split',
      id: 'split-12',
      direction: 'horizontal',
      children: [{ type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal' }],
      sizes: [1],
    })
    expect(createPane().id).toBe('pane-13')
  })

  it('never rewinds the counter', () => {
    createPane()
    createPane()
    adoptIds({ type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal' })
    expect(createPane().id).toBe('pane-3')
  })

  it('ignores ids that do not end in a number', () => {
    adoptIds({ type: 'pane', id: 'restored-from-phone', title: 'zsh', kind: 'terminal' })
    expect(createPane().id).toBe('pane-1')
  })
})

describe('tabs', () => {
  it('turns a lone pane into tabs and shows the new tab', () => {
    const a = createPane()
    const b = createPane()
    const root = addTab(a, a.id, b)
    expect(root).toMatchObject({ type: 'tabs', activeId: b.id })
    expect(paneIds(root)).toEqual([a.id, b.id])
    expect(isPaneShown(root, a.id)).toBe(false)
    expect(isPaneShown(root, b.id)).toBe(true)
  })

  it('inserts a new tab right after the tab it was opened from', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    const root = addTab(tabsOf(a.id, a, b), a.id, c)
    expect(paneIds(root)).toEqual([a.id, c.id, b.id])
  })

  it('adds a tab inside a split without touching the other side', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    const split = splitOf('horizontal', a, b)
    const root = addTab(split, b.id, c)
    expect(root.type === 'split' && root.children[0]).toBe(a)
    expect(tabsOfPane(root, c.id)?.children.map((p) => p.id)).toEqual([b.id, c.id])
  })

  it('selects a tab and returns the same tree when it is already shown', () => {
    const a = createPane()
    const b = createPane()
    const root = tabsOf(a.id, a, b)
    expect(selectTab(root, a.id)).toBe(root)
    expect(selectTab(root, b.id)).toMatchObject({ activeId: b.id })
  })

  it('shows the next tab when the shown tab closes', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    const root = closePane(tabsOf(b.id, a, b, c), b.id)
    expect(root).toMatchObject({ type: 'tabs', activeId: c.id })
    expect(paneIds(root)).toEqual([a.id, c.id])
  })

  it('collapses back to a plain pane when one tab is left', () => {
    const a = createPane()
    const b = createPane()
    expect(closePane(tabsOf(a.id, a, b), a.id)).toBe(b)
  })

  it('splits beside the whole tab stack, not inside it', () => {
    const a = createPane()
    const b = createPane()
    const tabs = tabsOf(b.id, a, b)
    const { root, newPaneId } = splitPane(tabs, b.id, 'vertical')
    expect(root.type).toBe('split')
    if (root.type === 'split') {
      expect(root.children[0]).toBe(tabs)
      expect(root.children[1].id).toBe(newPaneId)
    }
  })

  it('moves a tab out to an edge, leaving the rest as a pane', () => {
    const a = createPane()
    const b = createPane()
    const moved = movePane(tabsOf(a.id, a, b), a.id, b.id, 'right')
    expect(moved.type === 'split' && moved.children.map((c) => c.id)).toEqual([b.id, a.id])
  })

  it('ignores a center drop onto a tab of the same stack', () => {
    const a = createPane()
    const b = createPane()
    const root = tabsOf(a.id, a, b)
    expect(movePane(root, a.id, b.id, 'center')).toBe(root)
  })

  it('drops diff tabs and keeps the shown tab valid', () => {
    const a = createPane()
    const d = { ...createPane(), kind: 'diff' as const }
    const b = createPane()
    const root = withoutKind(tabsOf(d.id, a, d, b), 'diff')
    expect(root).toMatchObject({ type: 'tabs', activeId: b.id })
  })

  it('reads tab panes through findPane, firstPaneId and adoptIds', () => {
    const a = createPane()
    const b = createPane()
    const root = tabsOf(b.id, a, b)
    expect(findPane(root, a.id)).toBe(a)
    expect(firstPaneId(root)).toBe(b.id)
    resetIds()
    adoptIds(root)
    expect(Number(createPane().id.split('-')[1])).toBeGreaterThan(Number(root.id.split('-')[1]))
  })
})

describe('setPaneHibernated', () => {
  it('marks and clears a pane, returning the same tree when nothing changes', () => {
    const root = createPane()
    const asleep = setPaneHibernated(root, root.id, true)
    expect(asleep).toMatchObject({ hibernated: true })
    expect(setPaneHibernated(asleep, root.id, true)).toBe(asleep)
    const awake = setPaneHibernated(asleep, root.id, false)
    expect(awake).not.toHaveProperty('hibernated')
    expect(setPaneHibernated(awake, root.id, false)).toBe(awake)
  })
})
