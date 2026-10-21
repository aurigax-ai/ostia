import { beforeEach, describe, expect, it } from 'vitest'
import {
  canCollapse,
  changeCollapse,
  foldSplitTab,
  isStrip,
  isTucked,
  STRIP_SIZE,
  settleCollapse,
  stripAxis,
  stripSizes,
} from './collapse'
import { setSizes } from './panelSize'
import {
  createPane,
  findPane,
  findSplitTab,
  isPaneShown,
  resetIds,
  splitOf,
  splitTabOfPane,
  tabsOf,
  tabsOfPane,
} from './tree'
import type { LayoutNode, PaneNode, SplitNode } from './types'

beforeEach(() => resetIds())

function workers() {
  const [a, b, c, d] = [createPane(), createPane(), createPane(), createPane()]
  const lone = createPane()
  const tab: SplitNode = { ...splitOf('horizontal', a, b, c, d), name: 'workers' }
  const root: LayoutNode = tabsOf(a.id, lone, tab)
  return { a, b, c, d, lone, root }
}

function collapsedIds(root: LayoutNode, paneId: string): string[] {
  const tab = splitTabOfPane(root, paneId)
  if (!tab) return []
  const ids: string[] = []
  const walk = (node: LayoutNode): void => {
    if (node.type === 'pane') {
      if (node.collapsed) ids.push(node.id)
    } else for (const child of node.children) walk(child)
  }
  walk(tab)
  return ids
}

function shownOf(root: LayoutNode, paneId: string): string | undefined {
  return tabsOfPane(root, paneId)?.activeId
}

describe('collapse', () => {
  it('collapses a pane of a split tab and keeps the others expanded', () => {
    const { b, root } = workers()
    const next = changeCollapse(root, b.id, 'collapse')
    expect(collapsedIds(next, b.id)).toEqual([b.id])
    expect(isPaneShown(next, b.id)).toBe(false)
  })

  it('moves the shown pane to the nearest expanded one when the shown pane collapses', () => {
    const { a, b, c, root } = workers()
    const once = changeCollapse(root, a.id, 'collapse')
    expect(shownOf(once, a.id)).toBe(b.id)
    const twice = changeCollapse(changeCollapse(once, c.id, 'collapse'), b.id, 'collapse')
    expect(shownOf(twice, a.id)).not.toBe(b.id)
    expect(findPane(twice, shownOf(twice, a.id) ?? '')?.collapsed).toBeUndefined()
  })

  it('never collapses the last expanded pane of a split tab', () => {
    const { a, b, c, d, root } = workers()
    const three = [a, b, c].reduce<LayoutNode>((r, p) => changeCollapse(r, p.id, 'collapse'), root)
    expect(changeCollapse(three, d.id, 'collapse')).toBe(three)
    expect(canCollapse(splitTabOfPane(three, d.id) as SplitNode, d.id)).toBe(false)
  })

  it('leaves panes outside a split tab and unknown panes alone, same object', () => {
    const { lone, root } = workers()
    expect(changeCollapse(root, lone.id, 'collapse')).toBe(root)
    expect(changeCollapse(root, 'nope', 'collapse')).toBe(root)
    expect(changeCollapse(root, lone.id, 'collapseOthers')).toBe(root)
    expect(changeCollapse(root, lone.id, 'expandAll')).toBe(root)
  })

  it('returns the same object when a pane is collapsed already', () => {
    const { b, root } = workers()
    const once = changeCollapse(root, b.id, 'collapse')
    expect(changeCollapse(once, b.id, 'collapse')).toBe(once)
  })

  it('collapses every other pane and shows the kept one', () => {
    const { a, b, c, d, root } = workers()
    const next = changeCollapse(root, c.id, 'collapseOthers')
    expect(collapsedIds(next, c.id)).toEqual([a.id, b.id, d.id])
    expect(shownOf(next, c.id)).toBe(c.id)
    expect(changeCollapse(next, c.id, 'collapseOthers')).toBe(next)
  })

  it('expands every pane of the split tab', () => {
    const { a, c, root } = workers()
    const next = changeCollapse(root, c.id, 'collapseOthers')
    const open = changeCollapse(next, a.id, 'expandAll')
    expect(collapsedIds(open, a.id)).toEqual([])
    expect(changeCollapse(open, a.id, 'expandAll')).toBe(open)
  })

  it('treats a sub-split whose panes are all collapsed as one strip', () => {
    const [a, b, c] = [createPane(), createPane(), createPane()]
    const row = splitOf('horizontal', { ...b, collapsed: true }, { ...c, collapsed: true })
    expect(isStrip(row)).toBe(true)
    expect(isStrip(splitOf('horizontal', { ...b, collapsed: true }, c))).toBe(false)
    expect(isStrip(a)).toBe(false)
  })

  it('names the axis a pane collapses along', () => {
    const [a, b, c] = [createPane(), createPane(), createPane()]
    const grid = splitOf('vertical', splitOf('horizontal', a, b), c)
    expect(stripAxis(grid, a.id)).toBe('horizontal')
    expect(stripAxis(grid, c.id)).toBe('vertical')
    expect(stripAxis(grid, 'nope')).toBeNull()
  })
})

describe('settleCollapse', () => {
  it('returns the same object when every collapsed pane is valid', () => {
    const { b, root } = workers()
    const next = changeCollapse(root, b.id, 'collapse')
    expect(settleCollapse(next)).toBe(next)
    expect(settleCollapse(root)).toBe(root)
  })

  it('expands a pane that left its split tab', () => {
    const pane: PaneNode = { ...createPane(), collapsed: true }
    const other = createPane()
    expect(settleCollapse(pane)).toEqual({ ...pane, collapsed: undefined })
    const outer = splitOf('horizontal', pane, other)
    const settled = settleCollapse(outer)
    expect(findPane(settled, pane.id)?.collapsed).toBeUndefined()
    const stacked = tabsOf(other.id, pane, other)
    expect(findPane(settleCollapse(stacked), pane.id)?.collapsed).toBeUndefined()
  })

  it('expands the shown pane of a stack and the first pane of a tab with none expanded', () => {
    const [a, b, c] = [createPane(), createPane(), createPane()]
    const tab = splitOf('horizontal', { ...a, collapsed: true }, { ...b, collapsed: true })
    const shown = settleCollapse(tabsOf(b.id, c, tab))
    expect(findPane(shown, b.id)?.collapsed).toBeUndefined()
    expect(findPane(shown, a.id)?.collapsed).toBe(true)
    const hidden = settleCollapse(tabsOf(c.id, c, tab))
    expect(findPane(hidden, a.id)?.collapsed).toBeUndefined()
    expect(findPane(hidden, b.id)?.collapsed).toBe(true)
  })
})

describe('strip sizes', () => {
  it('gives strips their fixed size and shares the rest by the stored proportions', () => {
    expect(stripSizes([300, 500, 100], [false, true, false], 1000 + STRIP_SIZE)).toEqual([
      750,
      STRIP_SIZE,
      250,
    ])
    expect(stripSizes([1, 1, 1], [true, false, false], 2 * 500 + STRIP_SIZE)).toEqual([
      STRIP_SIZE,
      500,
      500,
    ])
  })

  it('gives a pane that just expanded its stored size back and shrinks the others', () => {
    expect(stripSizes([365, 704], [false, false], 730, [true, false])).toEqual([365, 365])
    expect(stripSizes([900, 704], [false, false], 730, [true, false])).toEqual([
      (900 / 1604) * 730,
      (704 / 1604) * 730,
    ])
  })

  it('keeps the stored sizes when no total is known', () => {
    expect(stripSizes([300, 500, 100], [false, true, false])).toEqual([300, STRIP_SIZE, 100])
  })

  it('keeps a strip child’s stored size when the split reports its strip size', () => {
    const [a, b] = [createPane(), createPane()]
    const split = { ...splitOf('horizontal', a, { ...b, collapsed: true }), sizes: [400, 600] }
    const next = setSizes(split, split.id, [974, STRIP_SIZE])
    expect(next.type === 'split' && next.sizes).toEqual([974, 600])
    expect(setSizes(next, split.id, [974, STRIP_SIZE])).toBe(next)
  })
})

describe('foldSplitTab', () => {
  function stack() {
    const [lone, a, b, c, d] = [
      createPane(),
      createPane(),
      createPane(),
      createPane(),
      createPane(),
    ]
    const first: SplitNode = { ...splitOf('horizontal', a, b), name: 'workers' }
    const second: SplitNode = { ...splitOf('horizontal', c, d), name: 'more' }
    return { lone, a, b, c, d, first, second }
  }

  it('folds a split tab that is not shown and leaves the shown tab alone', () => {
    const { lone, a, first, second } = stack()
    const root = tabsOf(lone.id, lone, first, second)
    const next = foldSplitTab(root, first.id)
    expect(findSplitTab(next, first.id)?.folded).toBe(true)
    expect(shownOf(next, lone.id)).toBe(lone.id)
    expect(isTucked(next, a.id)).toBe(true)
    expect(foldSplitTab(next, first.id)).toBe(next)
  })

  it('shows the next tab when the shown split tab folds, skipping folded tabs and collapsed panes', () => {
    const { lone, a, c, d, first, second } = stack()
    const tucked = changeCollapse(tabsOf(c.id, lone, first, second), c.id, 'collapse')
    const root = foldSplitTab(tucked, first.id)
    expect(shownOf(root, a.id)).toBe(d.id)
    const back = foldSplitTab(root, second.id)
    expect(shownOf(back, a.id)).toBe(lone.id)
  })

  it('refuses to fold the shown tab when no other tab can be shown, and unknown ids', () => {
    const { lone, first, second } = stack()
    const root = foldSplitTab(tabsOf(lone.id, lone, first, second), first.id)
    const onlyFolded = foldSplitTab(root, second.id)
    expect(findSplitTab(onlyFolded, second.id)?.folded).toBe(true)
    const solo = tabsOf(first.children[0].id, first, { ...second, folded: true as const })
    expect(foldSplitTab(solo, first.id)).toBe(solo)
    expect(foldSplitTab(root, 'nope')).toBe(root)
  })

  it('unfolds the shown tab and a split that left its stack when settled', () => {
    const { lone, a, first } = stack()
    const folded = { ...first, folded: true as const }
    const shown = settleCollapse(tabsOf(a.id, lone, folded))
    expect(findSplitTab(shown, first.id)?.folded).toBeUndefined()
    const hidden = tabsOf(lone.id, lone, folded)
    expect(settleCollapse(hidden)).toBe(hidden)
    const loose = settleCollapse(splitOf('horizontal', lone, folded))
    expect(loose.type === 'split' && loose.children[1]).not.toHaveProperty('folded')
  })
})
