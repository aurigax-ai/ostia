import { beforeEach, describe, expect, it } from 'vitest'
import {
  createPane,
  findPane,
  landTab,
  paneIds,
  resetIds,
  splitOf,
  splitPane,
  splitTabOfPane,
  tabsOf,
  takeTab,
} from './tree'
import type { LayoutNode } from './types'

beforeEach(() => resetIds())

function stackWithSplitTab() {
  const [a, b, c] = [createPane(), createPane(), createPane()]
  const root = splitPane(tabsOf(b.id, a, b), b.id, 'horizontal', c).root
  const split = splitTabOfPane(root, b.id)
  if (!split) throw new Error('expected a split tab')
  return { a, b, c, root, split }
}

describe('takeTab', () => {
  it('takes a plain tab out of a stack and picks its neighbour as successor', () => {
    const [a, b] = [createPane(), createPane()]
    const root = tabsOf(b.id, a, b)
    const taken = takeTab(root, b.id)
    expect(taken?.tab).toBe(b)
    expect(taken?.rest).toBe(a)
    expect(taken?.successor).toBe(a.id)
  })

  it('takes one segment of a split tab alone and leaves its sibling', () => {
    const { a, b, c, root } = stackWithSplitTab()
    const taken = takeTab(root, c.id)
    expect(taken?.tab).toBe(c)
    expect(taken?.rest && paneIds(taken.rest)).toEqual([a.id, b.id])
    expect(taken?.successor).toBe(b.id)
  })

  it('takes the whole split tab by its id', () => {
    const { a, b, c, root, split } = stackWithSplitTab()
    const taken = takeTab(root, split.id)
    expect(taken?.tab).toBe(split)
    expect(taken?.tab && paneIds(taken.tab)).toEqual([b.id, c.id])
    expect(taken?.rest).toBe(a)
    expect(taken?.successor).toBe(a.id)
  })

  it('leaves nothing when the tab is the whole layout', () => {
    const a = createPane()
    expect(takeTab(a, a.id)).toEqual({ tab: a, rest: null, successor: null })
  })

  it('takes a pane out of a plain split', () => {
    const [a, b] = [createPane(), createPane()]
    const taken = takeTab(splitOf('horizontal', a, b), a.id)
    expect(taken?.rest).toBe(b)
    expect(taken?.successor).toBe(b.id)
  })

  it('returns null for an unknown id and never changes the tree', () => {
    const { root } = stackWithSplitTab()
    const before = JSON.stringify(root)
    expect(takeTab(root, 'nope')).toBeNull()
    takeTab(root, paneIds(root)[1])
    expect(JSON.stringify(root)).toBe(before)
  })
})

describe('landTab', () => {
  it('becomes the whole layout of an empty workspace, a split tab as an ordinary split', () => {
    const { split } = stackWithSplitTab()
    const named = { ...split, name: 'workers' }
    const landed = landTab(null, named, 'x')
    expect(landed).toMatchObject({ type: 'split', id: split.id })
    expect(landed).not.toHaveProperty('name')
    const pane = createPane()
    expect(landTab(null, pane, 'x')).toBe(pane)
  })

  it('adds the tab beside the anchor and shows it', () => {
    const [a, b, moved] = [createPane(), createPane(), createPane()]
    const landed = landTab(tabsOf(a.id, a, b), moved, a.id)
    expect(landed).toMatchObject({ type: 'tabs', activeId: moved.id })
    expect(landed.type === 'tabs' && landed.children.map((c) => c.id)).toEqual([
      a.id,
      moved.id,
      b.id,
    ])
  })

  it('turns a lone pane into a stack and keeps a split tab whole', () => {
    const { split } = stackWithSplitTab()
    const target = createPane()
    const landed = landTab(target, split, target.id)
    expect(landed).toMatchObject({ type: 'tabs' })
    expect(landed.type === 'tabs' && landed.children[1]).toBe(split)
  })

  it('falls back to the first pane when the anchor is gone', () => {
    const [a, b] = [createPane(), createPane()]
    const root: LayoutNode = splitOf('horizontal', a, b)
    const moved = createPane()
    const landed = landTab(root, moved, 'gone')
    expect(findPane(landed, moved.id)).toBe(moved)
    expect(paneIds(landed)).toEqual([a.id, moved.id, b.id])
  })
})
