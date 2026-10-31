import { describe, expect, it } from 'vitest'
import { foldSplitTab, settleCollapse } from './collapse'
import { arrangeSplitTab, joinSplitTab, separateFromSplitTab, splitTabToTabs } from './tabJoin'
import {
  closePane,
  createPane,
  findPane,
  findSplitTabByName,
  isPaneShown,
  paneIds,
  selectTab as selectTabFor,
  splitOf,
  splitTabOfPane,
  tabsOf,
  tabsOfPane,
} from './tree'
import type { LayoutNode, PaneNode, SplitNode } from './types'

const panes = (n: number): PaneNode[] => Array.from({ length: n }, () => createPane())

describe('arrangeSplitTab', () => {
  it('puts panes side by side with equal sizes while they fit the columns', () => {
    const three = panes(3)
    const tab = arrangeSplitTab(three, 3, 'workers')
    expect(tab).toMatchObject({ direction: 'horizontal', sizes: [1, 1, 1], name: 'workers' })
    expect(tab.children).toEqual(three)
  })

  it('turns into a grid of equal rows past the columns', () => {
    const five = panes(5)
    const tab = arrangeSplitTab(five, 3, 'workers')
    expect(tab).toMatchObject({ direction: 'vertical', sizes: [1, 1] })
    expect(tab.children.map((row) => paneIds(row))).toEqual([
      five.slice(0, 3).map((p) => p.id),
      five.slice(3).map((p) => p.id),
    ])
    const four = arrangeSplitTab(panes(4), 3, 'workers')
    expect(four.children.map((row) => paneIds(row).length)).toEqual([2, 2])
  })

  it('returns the current tab when it already has the arranged shape', () => {
    const tab = arrangeSplitTab(panes(5), 3, 'workers')
    expect(arrangeSplitTab(paneList(tab), 3, 'workers', tab)).toBe(tab)
    const grown = arrangeSplitTab([...paneList(tab), createPane()], 3, 'workers', tab)
    expect(grown.id).toBe(tab.id)
    expect(grown).not.toBe(tab)
  })
})

function paneList(node: LayoutNode): PaneNode[] {
  if (node.type === 'pane') return [node]
  return node.children.flatMap(paneList)
}

describe('joinSplitTab', () => {
  const stack = () => {
    const [a, b, c, d] = panes(4)
    return { a, b, c, d, root: tabsOf(a.id, a, b, c, d) as LayoutNode }
  }

  it('creates the named tab where its first pane was and keeps the shown tab', () => {
    const { a, b, c, d, root } = stack()
    const next = joinSplitTab(
      root,
      [c, b].map((p) => p.id),
      'workers',
      3,
    )
    const tabs = tabsOfPane(next, a.id)
    expect(tabs?.children.map((t) => paneIds(t))).toEqual([[a.id], [c.id, b.id], [d.id]])
    expect(findSplitTabByName(next, 'workers')).toMatchObject({ sizes: [1, 1] })
    expect(isPaneShown(next, a.id)).toBe(true)
  })

  it('adds panes to an existing tab of that name and leaves its members alone', () => {
    const { a, b, c, d, root } = stack()
    const once = joinSplitTab(root, [b.id, c.id], 'workers', 3)
    const twice = joinSplitTab(once, [d.id], 'workers', 3)
    expect(paneIds(findSplitTabByName(twice, 'workers') as SplitNode)).toEqual([b.id, c.id, d.id])
    expect(findSplitTabByName(twice, 'workers')?.id).toBe(findSplitTabByName(once, 'workers')?.id)
    expect(joinSplitTab(twice, [b.id, d.id], 'workers', 3)).toBe(twice)
    expect(splitTabOfPane(twice, a.id)).toBeNull()
  })

  it('joins a lone pane to the partner it is given, and to nothing without one', () => {
    const { b, c, root } = stack()
    expect(joinSplitTab(root, [c.id], 'workers', 3)).toBe(root)
    const next = joinSplitTab(root, [c.id], 'workers', 3, b.id)
    expect(paneIds(findSplitTabByName(next, 'workers') as SplitNode)).toEqual([b.id, c.id])
  })

  it('takes a pane out of another split tab', () => {
    const { a, b, c, d, root } = stack()
    const other = joinSplitTab(root, [a.id, b.id, c.id], 'api', 3)
    const next = joinSplitTab(other, [c.id, d.id], 'workers', 3)
    expect(paneIds(findSplitTabByName(next, 'api') as SplitNode)).toEqual([a.id, b.id])
    expect(paneIds(findSplitTabByName(next, 'workers') as SplitNode)).toEqual([c.id, d.id])
  })

  it('leaves an ordinary split when the tab would be the only one', () => {
    const [a, b] = panes(2)
    const next = joinSplitTab(splitOf('vertical', a, b), [a.id, b.id], 'workers', 3)
    expect(next).toMatchObject({ type: 'split', direction: 'horizontal' })
    expect(next).not.toHaveProperty('name')
  })
})

describe('separateFromSplitTab', () => {
  it('puts a pane into its own tab after its split tab and rearranges the rest', () => {
    const [a, b, c, d] = panes(4)
    const root = joinSplitTab(tabsOf(a.id, a, b, c, d), [b.id, c.id, d.id], 'workers', 2)
    const next = separateFromSplitTab(root, [c.id], 2)
    const tabs = tabsOfPane(next, a.id)
    expect(tabs?.children.map((t) => paneIds(t))).toEqual([[a.id], [b.id, d.id], [c.id]])
    expect(findSplitTabByName(next, 'workers')).toMatchObject({ direction: 'horizontal' })
  })

  it('leaves a pane that is already its own tab', () => {
    const [a, b] = panes(2)
    const root = tabsOf(a.id, a, b)
    expect(separateFromSplitTab(root, [b.id], 3)).toBe(root)
  })
})

describe('splitTabToTabs', () => {
  it('turns every pane into its own tab in place and order, keeping the shown pane', () => {
    const [a, b, c, d, e] = panes(5)
    const joined = joinSplitTab(tabsOf(a.id, a, b, c, d, e), [b.id, c.id, d.id], 'workers', 2)
    const root = selectTabFor(joined, c.id)
    const next = splitTabToTabs(root, (splitTabOfPane(root, b.id) as SplitNode).id)
    const tabs = tabsOfPane(next, a.id)
    expect(tabs?.children.map((t) => paneIds(t))).toEqual([[a.id], [b.id], [c.id], [d.id], [e.id]])
    expect(tabs?.children.every((t) => t.type === 'pane')).toBe(true)
    expect(tabs?.activeId).toBe(c.id)
    expect(tabs?.children[2]).toBe(findPane(root, c.id))
  })

  it('ungroups a folded split tab', () => {
    const [a, b, c] = panes(3)
    const joined = joinSplitTab(tabsOf(a.id, a, b, c), [b.id, c.id], 'workers', 3)
    const id = (splitTabOfPane(joined, b.id) as SplitNode).id
    const folded = foldSplitTab(joined, id)
    const next = splitTabToTabs(folded, id)
    expect(splitTabOfPane(next, b.id)).toBeNull()
    expect(paneIds(next)).toEqual([a.id, b.id, c.id])
  })

  it('returns the same root for an unknown id or a pane', () => {
    const [a, b] = panes(2)
    const root = tabsOf(a.id, a, b)
    expect(splitTabToTabs(root, 'nope')).toBe(root)
    expect(splitTabToTabs(root, a.id)).toBe(root)
  })
})

describe('a folded split tab stays folded', () => {
  function folded() {
    const [lone, a, b, e, c, d] = panes(6)
    const joined = joinSplitTab(
      tabsOf(lone.id, lone, a, b, e, c, d),
      [a.id, b.id, e.id],
      'workers',
      3,
    )
    const tab = findSplitTabByName(joined, 'workers') as SplitNode
    const tucked = {
      ...joined,
      children: (joined as ReturnType<typeof tabsOf>).children.map((child) =>
        child === tab
          ? { ...tab, children: [{ ...a, collapsed: true as const }, b, e], folded: true as const }
          : child,
      ),
    } as LayoutNode
    return { lone, a, b, e, c, d, root: foldSplitTab(tucked, tab.id) }
  }

  const settled = (root: LayoutNode, shownId: string) => settleCollapse(selectTabFor(root, shownId))

  it('keeps the fold, the collapsed pane and the shown tab when a pane joins', () => {
    const { lone, a, c, root } = folded()
    const next = settled(joinSplitTab(root, [c.id], 'workers', 3), lone.id)
    const tab = findSplitTabByName(next, 'workers') as SplitNode
    expect(tab.folded).toBe(true)
    expect(findPane(next, a.id)?.collapsed).toBe(true)
    expect(tabsOfPane(next, lone.id)?.activeId).toBe(lone.id)
    expect(paneIds(tab)).toContain(c.id)
  })

  it('keeps the fold, the collapsed pane and the shown tab when a pane leaves', () => {
    const { lone, a, b, e, root } = folded()
    const next = settled(separateFromSplitTab(root, [b.id], 3), lone.id)
    expect(paneIds(findSplitTabByName(next, 'workers') as SplitNode)).toEqual([a.id, e.id])
    expect((findSplitTabByName(next, 'workers') as SplitNode).folded).toBe(true)
    expect(findPane(next, a.id)?.collapsed).toBe(true)
    expect(tabsOfPane(next, lone.id)?.activeId).toBe(lone.id)
  })

  it('keeps the fold when a member closes', () => {
    const { lone, a, b, e, d, root } = folded()
    const grown = joinSplitTab(root, [d.id], 'workers', 3)
    const next = settled(closePane(grown, d.id), lone.id)
    expect((findSplitTabByName(next, 'workers') as SplitNode).folded).toBe(true)
    expect(findPane(next, a.id)?.collapsed).toBe(true)
    expect(paneIds(findSplitTabByName(next, 'workers') as SplitNode)).toEqual([a.id, b.id, e.id])
  })
})
