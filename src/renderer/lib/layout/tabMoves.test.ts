import { beforeEach, describe, expect, it } from 'vitest'
import { graftNode, movePane, moveTab, placementOf } from './tabMoves'
import {
  createPane,
  firstPaneId,
  paneIds,
  resetIds,
  splitOf,
  splitPane,
  tabsOf,
  tabsOfPane,
} from './tree'
import type { LayoutNode } from './types'

beforeEach(() => resetIds())

const idOf = (n: LayoutNode): string => (n.type === 'pane' ? n.id : 'split')

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
