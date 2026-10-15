import { beforeEach, describe, expect, it } from 'vitest'
import { paneInDirection } from './focusDirection'
import {
  setDefaultPaneTitle,
  setDefaultPaneTitles,
  setPaneBrowser,
  setPaneCwd,
  setPaneEditor,
  setPaneExtension,
  setPaneLocked,
  setPaneTitle,
} from './paneFields'
import { setSizes } from './panelSize'
import { graftNode, movePane, moveTab, placementOf } from './tabMoves'
import {
  addTab,
  adjacentTab,
  adoptIds,
  allPanes,
  backgroundTabAnchor,
  closePane,
  createPane,
  createTerminalPane,
  findPane,
  findSplitTab,
  findSplitTabByName,
  firstPaneId,
  focusIdOf,
  isPaneShown,
  mergeLayouts,
  paneIds,
  resetIds,
  selectTab,
  setSplitTabName,
  slotKey,
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

describe('slotKey', () => {
  it('keeps a slot’s key when a tab joins its lone pane, so the split around it stays mounted', () => {
    const terminal = createPane()
    const panel = createPane('extension')
    const before = splitOf('horizontal', terminal, panel)
    const after = addTab(before, panel.id, createPane('diff'))
    if (after.type !== 'split') throw new Error('expected a split')
    expect(after.children[1].type).toBe('tabs')
    expect(after.children.map(slotKey)).toEqual(before.children.map(slotKey))
  })

  it('names a split by its own id', () => {
    const split = splitOf('vertical', createPane(), createPane())
    expect(slotKey(split)).toBe(split.id)
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

  it('opens background tabs from one caller right after it in launch order', () => {
    const agent = createPane()
    const other = createPane()
    const opened: string[] = []
    let root: LayoutNode = tabsOf(agent.id, agent, other)
    for (let i = 0; i < 3; i++) {
      const tab = createPane()
      root = addTab(root, backgroundTabAnchor(root, agent.id, opened), tab, true)
      opened.push(tab.id)
    }
    expect(paneIds(root)).toEqual([agent.id, ...opened, other.id])
    expect(root).toMatchObject({ activeId: agent.id })
  })

  it("skips the caller's tabs that left its stack and ignores another caller's tabs", () => {
    const agent = createPane()
    const moved = createPane()
    const kept = createPane()
    const foreign = createPane()
    const root = splitOf('horizontal', tabsOf(agent.id, agent, kept, foreign), moved)
    expect(backgroundTabAnchor(root, agent.id, [kept.id, moved.id])).toBe(kept.id)
    expect(backgroundTabAnchor(root, agent.id, [moved.id, 'pane-closed'])).toBe(agent.id)
    expect(backgroundTabAnchor(root, agent.id, [])).toBe(agent.id)
    expect(backgroundTabAnchor(agent, agent.id, [kept.id])).toBe(agent.id)
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
    const split = splitPane(root, b.id, 'horizontal', c).root
    const named = setSplitTabName(split, tabIdOf(split, b.id) ?? '', 'api')
    expect(findSplitTabByName(named, 'api')).not.toBeNull()
    const closed = closePane(named, a.id)
    expect(closed).toMatchObject({ type: 'split' })
    expect(closed).not.toHaveProperty('name')
    expect(paneIds(closed)).toEqual([b.id, c.id])
  })

  it('names, renames and clears a split tab and finds it by name and id', () => {
    const { b, c, root } = stack()
    const next = splitPane(root, b.id, 'horizontal', c).root
    const tabId = tabIdOf(next, c.id) ?? ''
    const named = setSplitTabName(next, tabId, 'api')
    const tab = findSplitTabByName(named, 'api')
    expect(tab).toMatchObject({ id: tabId, name: 'api' })
    expect(findSplitTab(named, tabId)).toBe(tab)
    expect(setSplitTabName(named, tabId, 'api')).toBe(named)
    expect(findSplitTab(setSplitTabName(named, tabId, 'web'), tabId)).toMatchObject({ name: 'web' })
    expect(findSplitTab(setSplitTabName(named, tabId, null), tabId)).not.toHaveProperty('name')
    expect(setSplitTabName(root, b.id, 'web')).toBe(root)
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
    const split = splitPane(root, b.id, 'horizontal', c).root
    const withTab = setSplitTabName(split, tabIdOf(split, b.id) ?? '', 'api')
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
    const split = splitPane(root, b.id, 'horizontal', c).root
    const withTab = setSplitTabName(split, tabIdOf(split, b.id) ?? '', 'api')
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
