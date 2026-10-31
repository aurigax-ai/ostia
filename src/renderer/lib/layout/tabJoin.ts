import {
  allPanes,
  findPane,
  findSplitTab,
  findSplitTabByName,
  firstPaneId,
  insertTab,
  isPaneShown,
  paneIds,
  replaceSlot,
  replaceTab,
  selectTab,
  splitOf,
  splitTabOfPane,
  tabsOfPane,
  withoutPanes,
} from './tree'
import type { LayoutNode, PaneNode, SplitNode } from './types'

function rowCounts(count: number, columns: number): number[] {
  const perRow = Math.max(1, Math.floor(columns))
  if (count <= perRow) return [count]
  const rows = Math.ceil(count / perRow)
  const base = Math.floor(count / rows)
  const extra = count % rows
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0))
}

function shapeOf(node: LayoutNode): string {
  if (node.type === 'pane') return node.id
  if (node.type === 'tabs') return `tabs:${node.id}`
  return `${node.id}:${node.direction}[${node.sizes.join(',')}](${node.children.map(shapeOf).join(' ')})`
}

export function arrangeSplitTab(
  panes: PaneNode[],
  columns: number,
  name: string | undefined,
  current?: SplitNode,
): SplitNode {
  const counts = rowCounts(panes.length, columns)
  const oldRows =
    current?.direction === 'vertical'
      ? current.children.filter((c): c is SplitNode => c.type === 'split')
      : []
  let at = 0
  const rows = counts.map((n, i) => {
    const line = panes.slice(at, at + n)
    at += n
    if (line.length === 1) return line[0]
    const row = splitOf('horizontal', ...line)
    return oldRows[i] ? { ...row, id: oldRows[i].id } : row
  })
  const outer = counts.length === 1 ? splitOf('horizontal', ...panes) : splitOf('vertical', ...rows)
  const arranged: SplitNode = {
    ...outer,
    id: current?.id ?? outer.id,
    ...(name !== undefined ? { name } : {}),
    ...(current?.folded ? { folded: true as const } : {}),
  }
  const same = current && current.name === name && shapeOf(current) === shapeOf(arranged)
  return same ? current : arranged
}

function untabbed(tab: SplitNode): SplitNode {
  const { name: _name, ...split } = tab
  return split
}

function placeNear(
  root: LayoutNode,
  anchorId: string,
  moving: ReadonlySet<string>,
): { id: string; after: boolean } | null {
  const stack = tabsOfPane(root, anchorId)
  if (!stack) return null
  const at = stack.children.findIndex((c) => paneIds(c).includes(anchorId))
  const survivor = (i: number): string | undefined =>
    paneIds(stack.children[i]).find((id) => !moving.has(id))
  for (let i = at; i >= 0; i--) {
    const id = survivor(i)
    if (id) return { id, after: true }
  }
  for (let i = at + 1; i < stack.children.length; i++) {
    const id = survivor(i)
    if (id) return { id, after: false }
  }
  return null
}

const HOLD: PaneNode = { type: 'pane', id: 'split-tab-hold', title: '', kind: 'terminal' }

function placeTab(
  root: LayoutNode,
  tab: SplitNode,
  moving: ReadonlySet<string>,
): LayoutNode | null {
  const near = placeNear(root, paneIds(tab)[0], moving)
  if (near) {
    const held = withoutPanes(insertTab(root, near.id, HOLD, near.after), (p) => moving.has(p.id))
    if (held && tabsOfPane(held, HOLD.id)) return replaceTab(held, HOLD.id, () => tab)
  }
  const rest = withoutPanes(root, (p) => moving.has(p.id))
  return rest ? insertTab(rest, firstPaneId(rest), tab, true) : null
}

export function joinSplitTab(
  root: LayoutNode,
  ids: readonly string[],
  name: string,
  columns: number,
  partnerId?: string,
): LayoutNode {
  const existing = findSplitTabByName(root, name)
  const members = existing ? allPanes(existing) : []
  const joining = [...new Set(ids)]
    .filter((id) => !members.some((p) => p.id === id))
    .map((id) => findPane(root, id))
    .filter((p): p is PaneNode => p !== null)
  if (joining.length === 0) return root
  const partner =
    !existing && partnerId && !joining.some((p) => p.id === partnerId)
      ? findPane(root, partnerId)
      : null
  const panes = [...members, ...(partner ? [partner] : []), ...joining]
  if (panes.length < 2) return root
  const moving = new Set(panes.map((p) => p.id))
  const tab = arrangeSplitTab(panes, columns, name, existing ?? undefined)
  const placed = placeTab(root, tab, moving)
  if (!placed) return untabbed(tab)
  const shown = panes.find((p) => isPaneShown(root, p.id))
  return shown ? selectTab(placed, shown.id) : placed
}

export function separateFromSplitTab(
  root: LayoutNode,
  ids: readonly string[],
  columns: number,
): LayoutNode {
  let next = root
  for (const id of new Set(ids)) {
    const tab = splitTabOfPane(next, id)
    const pane = findPane(next, id)
    const stay = tab ? paneIds(tab).find((other) => other !== id) : undefined
    const rest = stay ? withoutPanes(next, (p) => p.id === id) : null
    if (!tab || !pane || !stay || !rest) continue
    const arranged = findSplitTab(rest, tab.id)
      ? replaceTab(rest, tab.id, (t) =>
          t.type === 'split' ? arrangeSplitTab(allPanes(t), columns, t.name, t) : t,
        )
      : rest
    next = insertTab(arranged, stay, pane, true)
  }
  return next
}

function expandedPane(pane: PaneNode): PaneNode {
  if (!pane.collapsed) return pane
  const { collapsed: _collapsed, ...rest } = pane
  return rest
}

export function splitTabToTabs(root: LayoutNode, splitTabId: string): LayoutNode {
  const tab = findSplitTab(root, splitTabId)
  const tabs = tab ? tabsOfPane(root, firstPaneId(tab)) : null
  if (!tab || !tabs) return root
  const members = allPanes(tab).map(expandedPane)
  const children = tabs.children.flatMap((c) => (c === tab ? members : [c]))
  return replaceSlot(root, tabs.id, () => ({ ...tabs, children }))
}
