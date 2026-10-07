import { beforeEach, describe, expect, it } from 'vitest'
import {
  addTab,
  adjacentTab,
  adoptIds,
  allPanes,
  closePane,
  createPane,
  createTerminalPane,
  findExtensionPane,
  findPane,
  findSplitTab,
  findSplitTabByName,
  firstPaneId,
  firstPaneOfKind,
  focusIdOf,
  followMovedFile,
  graftNode,
  hasLockedPane,
  isPaneShown,
  mergeLayouts,
  movePane,
  moveTab,
  nameSplitTabOf,
  paneIds,
  paneInDirection,
  placementOf,
  renamePane,
  resetIds,
  selectTab,
  setDefaultPaneTitle,
  setDefaultPaneTitles,
  setPaneBrowser,
  setPaneCwd,
  setPaneDiff,
  setPaneEditor,
  setPaneExtension,
  setPaneHibernated,
  setPaneLocked,
  setPaneTitle,
  setPaneUrl,
  setSizes,
  splitBeside,
  splitOf,
  splitPane,
  splitTabOfPane,
  tabIdOf,
  tabNeighbor,
  tabsOf,
  tabsOfPane,
  withoutPanes,
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

describe('mergeLayouts', () => {
  it('puts the source root beside the target root in a new horizontal split', () => {
    const target = splitOf('vertical', createPane(), createPane())
    const a = createPane()
    const b = createPane()
    const source = tabsOf(b.id, a, b)

    const merged = mergeLayouts(target, source)

    expect(merged.type).toBe('split')
    if (merged.type !== 'split') return
    expect(merged.direction).toBe('horizontal')
    expect(merged.children).toEqual([target, source])
    expect(merged.sizes).toEqual([1, 1])
  })

  it('keeps every pane id of both layouts and leaves the inputs untouched', () => {
    const target = createPane()
    const source = splitOf('horizontal', createPane(), createPane())
    const before = JSON.stringify([target, source])

    const merged = mergeLayouts(target, source)

    expect(paneIds(merged)).toEqual([...paneIds(target), ...paneIds(source)])
    expect(JSON.stringify([target, source])).toBe(before)
  })

  it('keeps a single source pane as its own slot, never a tab of the target', () => {
    const t1 = createPane()
    const t2 = createPane()
    const target = tabsOf(t1.id, t1, t2)
    const source = createPane()

    const merged = mergeLayouts(target, source)

    expect(tabsOfPane(merged, source.id)).toBeNull()
    expect(tabsOfPane(merged, t1.id)?.children.map((p) => p.id)).toEqual([t1.id, t2.id])
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

describe('renamePane', () => {
  it('pins the new title so program titles no longer replace it', () => {
    const pane = { ...createPane('terminal'), defaultTitle: true as const }
    const root = splitOf('horizontal', createPane(), pane)
    const renamed = renamePane(root, pane.id, '  W9 控制面補齊 ')
    expect(findPane(renamed, pane.id)).toMatchObject({
      title: 'W9 控制面補齊',
      titlePinned: true,
    })
    expect(findPane(renamed, pane.id)).not.toHaveProperty('defaultTitle')
    const after = setPaneTitle(renamed, pane.id, 'vim README.md')
    expect(after).toBe(renamed)
  })

  it('unpins on an empty title and keeps the current one until a program sets another', () => {
    const pane = createPane('terminal')
    const root = renamePane(splitOf('horizontal', createPane(), pane), pane.id, 'worker')
    const cleared = renamePane(root, pane.id, '')
    expect(findPane(cleared, pane.id)).not.toHaveProperty('titlePinned')
    expect(findPane(cleared, pane.id)?.title).toBe('worker')
    expect(findPane(setPaneTitle(cleared, pane.id, 'htop'), pane.id)?.title).toBe('htop')
  })

  it('returns the identical tree when nothing changes', () => {
    const pane = createPane('terminal')
    const root = renamePane(splitOf('horizontal', createPane(), pane), pane.id, 'worker')
    expect(renamePane(root, pane.id, 'worker')).toBe(root)
    const plain = splitOf('horizontal', createPane(), createPane())
    expect(renamePane(plain, 'missing', '')).toBe(plain)
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

  it('gives a remote file no folder, so it never moves the local tree or workspace', () => {
    const term = createPane('terminal', 'zsh', '/home/u/proj')
    const next = setPaneEditor(term, term.id, 'app.conf', 'remote://abcdef012345/srv/app/app.conf')
    const pane = findPane(next, term.id)
    expect(pane?.kind).toBe('editor')
    expect(pane?.filePath).toBe('remote://abcdef012345/srv/app/app.conf')
    expect(pane && 'cwd' in pane).toBe(false)
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

describe('withoutPanes', () => {
  it('removes every pane of the kind and collapses single-child splits', () => {
    const a = createPane()
    const d1 = createPane('diff')
    const d2 = createPane('diff')
    const root = splitOf('horizontal', a, splitOf('vertical', d1, d2))
    expect(withoutPanes(root, (pane) => pane.kind === 'diff')).toBe(a)
  })

  it('returns the same object when nothing matches and null when everything does', () => {
    const root = splitOf('horizontal', createPane(), createPane())
    expect(withoutPanes(root, (pane) => pane.kind === 'diff')).toBe(root)
    expect(withoutPanes(createPane('diff'), (pane) => pane.kind === 'diff')).toBeNull()
  })

  it('keeps the sizes of the surviving children', () => {
    const a = createPane()
    const b = createPane()
    const root = { ...splitOf('horizontal', a, createPane('diff'), b), sizes: [2, 1, 3] }
    expect(withoutPanes(root, (pane) => pane.kind === 'diff')).toMatchObject({ sizes: [2, 3] })
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

  it('adds a background tab without changing which tab is shown', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    const lone = addTab(a, a.id, b, true)
    expect(lone).toMatchObject({ type: 'tabs', activeId: a.id })
    expect(paneIds(lone)).toEqual([a.id, b.id])

    const stack = addTab(tabsOf(b.id, a, b), a.id, c, true)
    expect(stack).toMatchObject({ activeId: b.id })
    expect(paneIds(stack)).toEqual([a.id, c.id, b.id])
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

  it('splits beside the whole tab stack with splitBeside', () => {
    const a = createPane()
    const b = createPane()
    const tabs = tabsOf(b.id, a, b)
    const { root, newPaneId } = splitBeside(tabs, b.id, 'vertical')
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
    const root = withoutPanes(tabsOf(d.id, a, d, b), (pane) => pane.kind === 'diff')
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

describe('setPaneLocked', () => {
  it('marks and clears a pane, returning the same tree when nothing changes', () => {
    const a = createPane()
    const b = createPane()
    const root = tabsOf(a.id, a, b)
    expect(hasLockedPane(root)).toBe(false)
    const locked = setPaneLocked(root, b.id, true)
    expect(findPane(locked, b.id)).toMatchObject({ locked: true })
    expect(hasLockedPane(locked)).toBe(true)
    expect(setPaneLocked(locked, b.id, true)).toBe(locked)
    const open = setPaneLocked(locked, b.id, false)
    expect(findPane(open, b.id)).not.toHaveProperty('locked')
    expect(hasLockedPane(open)).toBe(false)
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

describe('placementOf', () => {
  it('remembers the tab before a tab that leaves a stack', () => {
    const [a, b, c] = [createPane(), createPane(), createPane()]
    expect(placementOf(tabsOf(b.id, a, b, c), b.id)).toEqual({ paneId: a.id, zone: 'center' })
    expect(placementOf(tabsOf(a.id, a, b), a.id)).toEqual({ paneId: b.id, zone: 'center' })
  })

  it('remembers the neighbor and side of a pane in a split', () => {
    const [a, b, c] = [createPane(), createPane(), createPane()]
    const row = splitOf('horizontal', a, b)
    expect(placementOf(row, b.id)).toEqual({ paneId: a.id, zone: 'right' })
    expect(placementOf(row, a.id)).toEqual({ paneId: b.id, zone: 'left' })
    const column = splitOf('vertical', splitOf('horizontal', a, b), c)
    expect(placementOf(column, c.id)).toEqual({ paneId: b.id, zone: 'bottom' })
  })

  it('has no placement for a lone pane', () => {
    const a = createPane()
    expect(placementOf(a, a.id)).toBeNull()
  })
})

describe('graftNode', () => {
  it('puts a returning pane back as a tab next to its old neighbor', () => {
    const [a, b, c] = [createPane(), createPane(), createPane()]
    const root = graftNode(splitOf('horizontal', a, b), c, { paneId: a.id, zone: 'center' })
    expect(tabsOfPane(root, c.id)?.children.map((p) => p.id)).toEqual([a.id, c.id])
    expect(paneIds(root)).toEqual([a.id, c.id, b.id])
  })

  it('puts every tab of a returning stack next to the anchor', () => {
    const [a, b, c] = [createPane(), createPane(), createPane()]
    const root = graftNode(a, tabsOf(b.id, b, c), { paneId: a.id, zone: 'center' })
    expect(root).toMatchObject({ type: 'tabs' })
    expect(paneIds(root)).toEqual([a.id, b.id, c.id])
  })

  it('splits beside the anchor on the remembered side', () => {
    const [a, b, c] = [createPane(), createPane(), createPane()]
    const root = graftNode(splitOf('vertical', a, b), c, { paneId: a.id, zone: 'left' })
    expect(root.type === 'split' && root.children[0]).toMatchObject({
      type: 'split',
      direction: 'horizontal',
    })
    expect(paneIds(root)).toEqual([c.id, a.id, b.id])
  })

  it('splits a returning split beside the anchor instead of flattening it into tabs', () => {
    const [a, b, c] = [createPane(), createPane(), createPane()]
    const root = graftNode(a, splitOf('vertical', b, c), { paneId: a.id, zone: 'center' })
    expect(root).toMatchObject({ type: 'split', direction: 'horizontal' })
    expect(paneIds(root)).toEqual([a.id, b.id, c.id])
  })

  it('adds a new split on the right when the anchor is gone', () => {
    const [a, b, c] = [createPane(), createPane(), createPane()]
    const root = graftNode(a, b, { paneId: c.id, zone: 'center' })
    expect(root).toMatchObject({ type: 'split', direction: 'horizontal' })
    expect(paneIds(root)).toEqual([a.id, b.id])
  })

  it('becomes the whole layout of a workspace with no panes', () => {
    const a = createPane()
    expect(graftNode(null, a)).toBe(a)
  })
})

describe('moveTab', () => {
  it('reorders tabs inside one stack and keeps the stack', () => {
    const [a, b, c] = [createPane(), createPane(), createPane()]
    const stack = tabsOf(a.id, a, b, c)
    const root = moveTab(stack, a.id, c.id, true)
    expect(root).toMatchObject({ type: 'tabs', id: stack.id, activeId: a.id })
    expect(paneIds(root)).toEqual([b.id, c.id, a.id])
  })

  it('moves a pane from a split into another stack before the hovered tab', () => {
    const [a, b, c] = [createPane(), createPane(), createPane()]
    const root = moveTab(splitOf('horizontal', a, tabsOf(b.id, b, c)), a.id, c.id, false)
    expect(root).toMatchObject({ type: 'tabs', activeId: a.id })
    expect(paneIds(root)).toEqual([b.id, a.id, c.id])
  })

  it('turns a lone target pane into a stack', () => {
    const [a, b] = [createPane(), createPane()]
    const root = moveTab(splitOf('vertical', a, b), b.id, a.id, true)
    expect(root).toMatchObject({ type: 'tabs' })
    expect(paneIds(root)).toEqual([a.id, b.id])
  })

  it('returns the same tree for an unknown pane or a drop on itself', () => {
    const [a, b] = [createPane(), createPane()]
    const root = splitOf('horizontal', a, b)
    expect(moveTab(root, a.id, a.id, true)).toBe(root)
    expect(moveTab(root, 'nope', b.id, true)).toBe(root)
  })
})

describe('paneInDirection', () => {
  const grid = (): LayoutNode => {
    const left = createPane('terminal', 'left')
    const topRight = createPane('terminal', 'top-right')
    const bottomRight = createPane('terminal', 'bottom-right')
    return splitOf('horizontal', left, splitOf('vertical', topRight, bottomRight))
  }

  it('returns the pane that shares the edge in the asked direction', () => {
    const root = grid()
    const [left, topRight, bottomRight] = allPanes(root).map((p) => p.id)
    expect(paneInDirection(root, left, 'right')).toBe(topRight)
    expect(paneInDirection(root, topRight, 'down')).toBe(bottomRight)
    expect(paneInDirection(root, bottomRight, 'up')).toBe(topRight)
    expect(paneInDirection(root, bottomRight, 'left')).toBe(left)
  })

  it('returns null at the outer edge and for a lone pane', () => {
    const root = grid()
    const [left, topRight] = allPanes(root).map((p) => p.id)
    expect(paneInDirection(root, left, 'left')).toBeNull()
    expect(paneInDirection(root, topRight, 'up')).toBeNull()
    const lone = createPane()
    expect(paneInDirection(lone, lone.id, 'right')).toBeNull()
  })

  it('follows split sizes and picks the neighbour nearest the middle of the pane', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    const d = createPane()
    const right = { ...splitOf('vertical', b, c, d), sizes: [2, 1, 1] }
    const root = splitOf('horizontal', a, right)
    expect(paneInDirection(root, a.id, 'right')).toBe(c.id)
  })

  it('moves to the shown tab of a tab stack and from any tab of one', () => {
    const a = createPane()
    const t1 = createPane()
    const t2 = createPane()
    const root = splitOf('horizontal', a, tabsOf(t2.id, t1, t2))
    expect(paneInDirection(root, a.id, 'right')).toBe(t2.id)
    expect(paneInDirection(root, t1.id, 'left')).toBe(a.id)
  })
})

describe('terminal default title', () => {
  it('marks a terminal created without a title as holding its default title', () => {
    expect(createPane()).toMatchObject({ kind: 'terminal', title: 'Terminal', defaultTitle: true })
    expect(createTerminalPane('終端機', '/srv')).toMatchObject({
      kind: 'terminal',
      title: '終端機',
      cwd: '/srv',
      defaultTitle: true,
    })
  })

  it('does not mark a terminal created with a title, or a pane of another kind', () => {
    expect(createPane('terminal', 'pnpm dev').defaultTitle).toBeUndefined()
    expect(createPane('editor').defaultTitle).toBeUndefined()
    expect(createPane('browser').defaultTitle).toBeUndefined()
  })

  it('names an untouched terminal after its shell and keeps it open to the next shell', () => {
    const pane = createPane()
    const bash = setDefaultPaneTitle(pane, pane.id, 'bash')
    expect(bash).toMatchObject({ title: 'bash', defaultTitle: true })
    expect(setDefaultPaneTitle(bash, pane.id, 'fish')).toMatchObject({ title: 'fish' })
    expect(setDefaultPaneTitle(bash, pane.id, 'bash')).toBe(bash)
  })

  it('keeps a title a program or a caller set when the shell is reported', () => {
    const pane = createPane()
    const titled = setPaneTitle(pane, pane.id, 'claude: fix the login bug')
    expect(titled).toEqual({ ...pane, title: 'claude: fix the login bug', defaultTitle: undefined })
    expect('defaultTitle' in titled).toBe(false)
    expect(setDefaultPaneTitle(titled, pane.id, 'bash')).toBe(titled)
    const given = createPane('terminal', 'pnpm dev')
    expect(setDefaultPaneTitle(given, given.id, 'bash')).toBe(given)
  })

  it('treats a program title equal to the shell name as set, so a later shell keeps it', () => {
    const pane = createPane()
    const bash = setDefaultPaneTitle(pane, pane.id, 'bash')
    const titled = setPaneTitle(bash, pane.id, 'bash')
    expect(titled.type === 'pane' && titled.defaultTitle).toBeUndefined()
    expect(setDefaultPaneTitle(titled, pane.id, 'zsh')).toBe(titled)
    expect(setPaneTitle(titled, pane.id, 'bash')).toBe(titled)
  })

  it('resets every untouched terminal of a tree to one title and leaves the others', () => {
    const fresh = createPane()
    const untouched = { ...fresh, title: 'bash' }
    const named = createPane('terminal', 'pnpm dev')
    const editor = createPane('editor', 'a.ts')
    const root = splitOf('horizontal', untouched, tabsOf(named.id, named, editor))
    const reset = setDefaultPaneTitles(root, 'Terminal')
    expect(allPanes(reset).map((p) => p.title)).toEqual(['Terminal', 'pnpm dev', 'a.ts'])
    expect(setDefaultPaneTitles(reset, 'Terminal')).toBe(reset)
  })

  it('drops the mark when the pane becomes an editor, a browser or an extension panel', () => {
    const [a, b, c] = [createPane(), createPane(), createPane()]
    const editor = setPaneEditor(a, a.id, 'a.ts', '/srv/a.ts')
    const browser = setPaneBrowser(b, b.id, 'https://example.com/')
    const panel = setPaneExtension(c, c.id, 'git', 'Git')
    for (const pane of [editor, browser, panel]) expect('defaultTitle' in pane).toBe(false)
  })

  it('splits with the pane it is given', () => {
    const root = createPane()
    const fresh = createTerminalPane('終端機')
    const result = splitPane(root, root.id, 'horizontal', fresh)
    expect(result.newPaneId).toBe(fresh.id)
    expect(findPane(result.root, fresh.id)).toBe(fresh)
  })
})

describe('adjacentTab', () => {
  it('steps through the tabs of the pane and wraps at both ends', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    const root = tabsOf(a.id, a, b, c)
    expect(adjacentTab(root, a.id, 1)).toBe(b.id)
    expect(adjacentTab(root, c.id, 1)).toBe(a.id)
    expect(adjacentTab(root, a.id, -1)).toBe(c.id)
    expect(adjacentTab(root, b.id, -1)).toBe(a.id)
  })

  it('finds the tab group inside a split', () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    const root = splitOf('horizontal', a, tabsOf(b.id, b, c))
    expect(adjacentTab(root, b.id, 1)).toBe(c.id)
  })

  it('returns null for a pane that is not in a tab group', () => {
    const a = createPane()
    const b = createPane()
    expect(adjacentTab(a, a.id, 1)).toBeNull()
    expect(adjacentTab(splitOf('vertical', a, b), a.id, -1)).toBeNull()
  })
})

describe('followMovedFile', () => {
  it('points editors at a renamed file and at files under a moved folder', () => {
    const file = { ...createPane('editor'), filePath: '/p/notes.md', title: 'notes.md' }
    const nested = { ...createPane('editor'), filePath: '/p/src/main.ts', title: 'main.ts' }
    const other = { ...createPane('editor'), filePath: '/p/srcx/a.ts', title: 'a.ts' }
    const root = splitOf('horizontal', file, splitOf('vertical', nested, other))

    const renamed = followMovedFile(root, '/p/notes.md', '/p/readme.md')
    expect(JSON.stringify(renamed)).toContain('"filePath":"/p/readme.md"')
    expect(JSON.stringify(renamed)).toContain('"title":"readme.md"')

    const moved = followMovedFile(root, '/p/src', '/p/lib')
    expect(JSON.stringify(moved)).toContain('"filePath":"/p/lib/main.ts"')
    expect(JSON.stringify(moved)).toContain('"filePath":"/p/srcx/a.ts"')
  })

  it('returns the same tree when no editor shows the moved path', () => {
    const root = splitOf('horizontal', createPane(), createPane())
    expect(followMovedFile(root, '/p/a', '/p/b')).toBe(root)
  })
})

describe('split tabs', () => {
  const stack = () => {
    const [a, b, c] = [createPane(), createPane(), createPane()]
    return { a, b, c, root: tabsOf(b.id, a, b) as LayoutNode }
  }

  it('turns the shown tab of a stack into a split tab when it splits', () => {
    const { a, b, c, root } = stack()
    const { root: next, newPaneId } = splitPane(root, b.id, 'horizontal', c)
    expect(newPaneId).toBe(c.id)
    expect(next).toMatchObject({ type: 'tabs', id: root.id, activeId: b.id })
    if (next.type !== 'tabs') throw new Error('expected tabs')
    expect(next.children[0]).toBe(a)
    expect(next.children[1]).toMatchObject({ type: 'split', direction: 'horizontal' })
    expect(paneIds(next.children[1])).toEqual([b.id, c.id])
    expect(splitTabOfPane(next, c.id)?.id).toBe(next.children[1].id)
  })

  it('splits a lone pane slot as before', () => {
    const a = createPane()
    const { root } = splitPane(a, a.id, 'vertical')
    expect(root).toMatchObject({ type: 'split', direction: 'vertical' })
  })

  it('grows a split tab inside itself, nesting another direction', () => {
    const { b, c, root } = stack()
    const d = createPane()
    const once = splitPane(root, b.id, 'horizontal', c).root
    const twice = splitPane(once, c.id, 'vertical', d).root
    const tab = splitTabOfPane(twice, d.id)
    expect(tab).toMatchObject({ direction: 'horizontal' })
    expect(tab?.children[1]).toMatchObject({ type: 'split', direction: 'vertical' })
    expect(paneIds(twice)).toHaveLength(4)
    expect(twice.type === 'tabs' && twice.children).toHaveLength(2)
  })

  it('adds a sibling in the same direction instead of nesting', () => {
    const { b, c, root } = stack()
    const d = createPane()
    const once = splitPane(root, b.id, 'horizontal', c).root
    const twice = splitPane(once, c.id, 'horizontal', d).root
    const tab = splitTabOfPane(twice, d.id)
    expect(tab?.children.map((n) => n.id)).toEqual([b.id, c.id, d.id])
    expect(tab?.sizes).toEqual([1, 0.5, 0.5])
  })

  it('shows only the panes of the shown tab', () => {
    const { a, b, c, root } = stack()
    const next = splitPane(root, b.id, 'horizontal', c).root
    expect(isPaneShown(next, b.id)).toBe(true)
    expect(isPaneShown(next, c.id)).toBe(true)
    expect(isPaneShown(next, a.id)).toBe(false)
    const other = selectTab(next, a.id)
    expect(isPaneShown(other, c.id)).toBe(false)
    expect(selectTab(next, c.id)).toMatchObject({ activeId: c.id })
    expect(isPaneShown(selectTab(next, c.id), b.id)).toBe(true)
  })

  it('turns a split tab closed down to one pane back into a plain tab', () => {
    const { a, b, c, root } = stack()
    const next = splitPane(root, b.id, 'horizontal', c).root
    const closed = closePane(next, b.id)
    expect(closed).toMatchObject({ type: 'tabs', activeId: c.id })
    expect(closed.type === 'tabs' && closed.children).toEqual([a, c])
  })

  it('keeps focus inside the split tab when its focused pane closes', () => {
    const { b, c, root } = stack()
    const d = createPane()
    const next = splitPane(splitPane(root, b.id, 'horizontal', c).root, c.id, 'horizontal', d).root
    const focused = selectTab(next, c.id)
    expect(closePane(focused, c.id)).toMatchObject({ activeId: b.id })
  })

  it('unwraps a lone split tab to an ordinary split without its name', () => {
    const { a, b, c, root } = stack()
    const named = nameSplitTabOf(splitPane(root, b.id, 'horizontal', c).root, b.id, 'api')
    const closed = closePane(named, a.id)
    expect(closed).toMatchObject({ type: 'split' })
    expect(closed).not.toHaveProperty('name')
    expect(paneIds(closed)).toEqual([b.id, c.id])
  })

  it('names a split tab once and finds it by name and id', () => {
    const { b, c, root } = stack()
    const next = splitPane(root, b.id, 'horizontal', c).root
    const named = nameSplitTabOf(next, c.id, 'api')
    const tab = findSplitTabByName(named, 'api')
    expect(tab).toMatchObject({ name: 'api' })
    expect(findSplitTab(named, tab?.id ?? '')).toBe(tab)
    expect(nameSplitTabOf(named, c.id, 'web')).toBe(named)
    expect(nameSplitTabOf(root, b.id, 'web')).toBe(root)
  })

  it('steps tabs, not panes, with adjacentTab and tabNeighbor', () => {
    const { a, b, c, root } = stack()
    const next = splitPane(root, b.id, 'horizontal', c).root
    const tabId = tabIdOf(next, c.id)
    expect(tabId).not.toBe(c.id)
    expect(adjacentTab(next, c.id, 1)).toBe(a.id)
    expect(adjacentTab(next, a.id, 1)).toBe(b.id)
    expect(tabNeighbor(next, a.id, 1)).toBe(tabId)
    expect(tabNeighbor(next, c.id, -1)).toBe(a.id)
  })

  it('moves the whole split tab in the strip and keeps its focused pane shown', () => {
    const { a, b, c, root } = stack()
    const next = selectTab(splitPane(root, b.id, 'horizontal', c).root, c.id)
    const tabId = tabIdOf(next, c.id) ?? ''
    const moved = moveTab(next, tabId, a.id, false)
    expect(moved.type === 'tabs' && moved.children.map((t) => t.id)).toEqual([tabId, a.id])
    expect(moved).toMatchObject({ activeId: c.id })
    expect(focusIdOf(moved, tabId)).toBe(c.id)
  })

  it('pulls one segment out of a split tab as its own tab', () => {
    const { a, b, c, root } = stack()
    const next = splitPane(root, b.id, 'horizontal', c).root
    const moved = moveTab(next, c.id, a.id, false)
    expect(moved.type === 'tabs' && moved.children).toEqual([c, a, b])
    expect(moved).toMatchObject({ activeId: c.id })
  })

  it('drops a pane on the edge of a pane in a stack into that tab', () => {
    const [a, b, c] = [createPane(), createPane(), createPane()]
    const root = splitOf('horizontal', tabsOf(a.id, a, b), c)
    const moved = movePane(root, c.id, a.id, 'bottom')
    expect(moved.type).toBe('tabs')
    expect(splitTabOfPane(moved, c.id)).toMatchObject({ direction: 'vertical' })
    expect(paneIds(splitTabOfPane(moved, c.id) as LayoutNode)).toEqual([a.id, c.id])
  })

  it('moves a whole split tab to an edge of a plain slot as an ordinary split', () => {
    const { b, c, root } = stack()
    const d = createPane()
    const withTab = nameSplitTabOf(splitPane(root, b.id, 'horizontal', c).root, b.id, 'api')
    const tree = splitOf('horizontal', withTab, d)
    const tabId = tabIdOf(tree, b.id) ?? ''
    const moved = movePane(tree, tabId, d.id, 'bottom')
    const outer = moved.type === 'split' ? moved.children[1] : null
    expect(outer).toMatchObject({ type: 'split', direction: 'vertical' })
    const inner = outer?.type === 'split' ? outer.children[1] : null
    expect(inner).toMatchObject({ type: 'split', id: tabId })
    expect(inner).not.toHaveProperty('name')
  })

  it('adds a split tab dropped on the center as a tab, keeping its name', () => {
    const { b, c, root } = stack()
    const d = createPane()
    const withTab = nameSplitTabOf(splitPane(root, b.id, 'horizontal', c).root, b.id, 'api')
    const tree = splitOf('horizontal', withTab, d)
    const tabId = tabIdOf(tree, b.id) ?? ''
    const moved = movePane(tree, tabId, d.id, 'center')
    const tabs = tabsOfPane(moved, d.id)
    expect(tabs?.children.map((t) => t.id)).toEqual([d.id, tabId])
    expect(findSplitTab(moved, tabId)).toMatchObject({ name: 'api' })
  })

  it('walks the shown split tab when moving focus by direction', () => {
    const { a, b, c, root } = stack()
    const e = createPane()
    const tree = splitOf('horizontal', e, splitPane(root, b.id, 'vertical', c).root)
    expect(paneInDirection(tree, b.id, 'down')).toBe(c.id)
    expect(paneInDirection(tree, c.id, 'left')).toBe(e.id)
    expect(paneInDirection(tree, e.id, 'right')).toBe(b.id)
    expect(paneInDirection(tree, a.id, 'left')).toBe(e.id)
    const hidden = selectTab(tree, a.id)
    expect(paneInDirection(hidden, e.id, 'right')).toBe(a.id)
  })

  it('resizes a split inside a split tab', () => {
    const { b, c, root } = stack()
    const next = splitPane(root, b.id, 'horizontal', c).root
    const tabId = tabIdOf(next, c.id) ?? ''
    const sized = setSizes(next, tabId, [3, 1])
    expect(findSplitTab(sized, tabId)?.sizes).toEqual([3, 1])
    expect(setSizes(next, 'nope', [1])).toBe(next)
  })

  it('remembers a split-tab neighbour and grafts a returning pane back into the tab', () => {
    const { b, c, root } = stack()
    const next = splitPane(root, b.id, 'horizontal', c).root
    const beside = placementOf(next, c.id)
    expect(beside).toEqual({ paneId: b.id, zone: 'right' })
    const without = closePane(next, c.id)
    const back = graftNode(without, c, beside ?? undefined)
    expect(splitTabOfPane(back, c.id)?.children.map((n) => n.id)).toEqual([b.id, c.id])
  })

  it('reads a split tab neighbour as a center placement for a plain tab', () => {
    const { a, b, c, root } = stack()
    const next = splitPane(root, b.id, 'horizontal', c).root
    expect(placementOf(next, a.id)).toEqual({ paneId: b.id, zone: 'center' })
  })

  it('maps pane changes through split tabs and returns the same tree for no change', () => {
    const { b, c, root } = stack()
    const next = splitPane(root, b.id, 'horizontal', c).root
    expect(setPaneCwd(next, c.id, '/x')).not.toBe(next)
    expect(findPane(setPaneCwd(next, c.id, '/x'), c.id)?.cwd).toBe('/x')
    expect(setPaneLocked(next, c.id, false)).toBe(next)
    expect(withoutPanes(next, () => false)).toBe(next)
  })
})
