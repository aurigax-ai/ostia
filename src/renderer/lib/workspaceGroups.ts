import type { WorkspaceGroupColor } from '@shared/workspaceGroups'
import { setPinned, withPinned } from './workspaceOrder'

export interface WorkspaceGroup {
  id: string
  name: string
  color?: WorkspaceGroupColor
  collapsed?: boolean
}

export interface Groupable {
  id: string
  pinned?: boolean
  groupId?: string
}

export interface Grouping<W extends Groupable> {
  workspaces: W[]
  groups: WorkspaceGroup[]
}

export type DragSource = { kind: 'workspace'; id: string } | { kind: 'group'; id: string }

export type DropTarget =
  | { kind: 'workspace'; id: string; place: 'before' | 'after' }
  | { kind: 'group'; id: string; place: 'before' | 'after' | 'inside' }
  | { kind: 'end' }

export interface GroupRule {
  pattern: string
  group: string
}

export interface Block<W extends Groupable> {
  group: WorkspaceGroup | null
  workspaces: W[]
}

export function withGroup<W extends Groupable>(w: W, groupId: string | undefined): W {
  if (w.groupId === groupId) return w
  const { groupId: _old, ...rest } = w
  return (groupId ? { ...rest, groupId } : rest) as W
}

function sameOrder<W extends Groupable>(a: W[], b: W[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i])
}

function settle<W extends Groupable>(prev: Grouping<W>, workspaces: W[]): Grouping<W> {
  const next = normalizeGroups({ workspaces, groups: prev.groups })
  return sameOrder(next.workspaces, prev.workspaces) && next.groups.length === prev.groups.length
    ? prev
    : next
}

export function normalizeGroups<W extends Groupable>(g: Grouping<W>): Grouping<W> {
  const known = new Map(g.groups.map((group) => [group.id, group]))
  const cleaned = g.workspaces.map((w) =>
    w.groupId && (w.pinned || !known.has(w.groupId)) ? withGroup(w, undefined) : w,
  )
  const workspaces: W[] = []
  const groups: WorkspaceGroup[] = []
  for (const w of cleaned) {
    if (!w.groupId) {
      workspaces.push(w)
      continue
    }
    const group = known.get(w.groupId)
    if (!group || groups.includes(group)) continue
    groups.push(group)
    for (const member of cleaned) if (member.groupId === w.groupId) workspaces.push(member)
  }
  return { workspaces, groups }
}

export function toBlocks<W extends Groupable>(g: Grouping<W>): Block<W>[] {
  const byId = new Map(g.groups.map((group) => [group.id, group]))
  const blocks: Block<W>[] = []
  for (const w of g.workspaces) {
    const group = (w.groupId && byId.get(w.groupId)) || null
    const last = blocks[blocks.length - 1]
    if (group && last?.group === group) last.workspaces.push(w)
    else blocks.push({ group, workspaces: [w] })
  }
  return blocks
}

export function groupMembers<W extends Groupable>(workspaces: W[], groupId: string): W[] {
  return workspaces.filter((w) => w.groupId === groupId)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}

export function moveWorkspaceBy<W extends Groupable>(
  g: Grouping<W>,
  id: string,
  delta: number,
): Grouping<W> {
  const from = g.workspaces.findIndex((w) => w.id === id)
  if (from === -1) return g
  const moving = g.workspaces[from]
  if (moving.groupId) {
    const first = g.workspaces.findIndex((w) => w.groupId === moving.groupId)
    const last = first + groupMembers(g.workspaces, moving.groupId).length - 1
    const to = clamp(from + delta, first, last)
    if (to === from) return g
    const others = g.workspaces.filter((w) => w.id !== id)
    return { ...g, workspaces: [...others.slice(0, to), moving, ...others.slice(to)] }
  }
  const blocks = toBlocks(g)
  const at = blocks.findIndex((b) => !b.group && b.workspaces[0].id === id)
  const pinned = blocks.filter((b) => b.workspaces[0].pinned).length
  const to = moving.pinned
    ? clamp(at + delta, 0, pinned - 1)
    : clamp(at + delta, pinned, blocks.length - 1)
  if (to === at) return g
  const others = blocks.filter((_, i) => i !== at)
  const reordered = [...others.slice(0, to), blocks[at], ...others.slice(to)]
  return { ...g, workspaces: reordered.flatMap((b) => b.workspaces) }
}

function pinnedCount<W extends Groupable>(list: W[]): number {
  return list.filter((w) => w.pinned).length
}

function dropWorkspace<W extends Groupable>(
  g: Grouping<W>,
  id: string,
  target: DropTarget,
): Grouping<W> {
  const from = g.workspaces.findIndex((w) => w.id === id)
  if (from === -1) return g
  if (target.kind === 'workspace' && target.id === id) return g
  const moving = g.workspaces[from]
  const others = g.workspaces.filter((w) => w.id !== id)
  let groupId: string | undefined
  let at: number
  if (target.kind === 'workspace') {
    const over = others.findIndex((w) => w.id === target.id)
    if (over === -1) return g
    groupId = others[over].groupId
    at = over + (target.place === 'after' ? 1 : 0)
  } else if (target.kind === 'group') {
    if (!g.groups.some((group) => group.id === target.id)) return g
    const first = others.findIndex((w) => w.groupId === target.id)
    groupId = target.place === 'before' ? undefined : target.id
    at = first === -1 ? from : first
  } else {
    groupId = undefined
    at = others.length
  }
  let placed = withGroup(moving, groupId)
  if (groupId) placed = withPinned(placed, false)
  const pinned = pinnedCount(others)
  at = placed.pinned ? Math.min(at, pinned) : Math.max(at, pinned)
  return settle(g, [...others.slice(0, at), placed, ...others.slice(at)])
}

function blockRange<W extends Groupable>(list: W[], groupId: string): [number, number] {
  const first = list.findIndex((w) => w.groupId === groupId)
  return [first, first + groupMembers(list, groupId).length]
}

function dropGroup<W extends Groupable>(
  g: Grouping<W>,
  groupId: string,
  target: DropTarget,
): Grouping<W> {
  const members = groupMembers(g.workspaces, groupId)
  if (members.length === 0) return g
  const others = g.workspaces.filter((w) => w.groupId !== groupId)
  let at: number
  if (target.kind === 'workspace') {
    const over = others.findIndex((w) => w.id === target.id)
    if (over === -1) return g
    const overGroup = others[over].groupId
    const [first, end] = overGroup ? blockRange(others, overGroup) : [over, over + 1]
    at = target.place === 'before' ? first : end
  } else if (target.kind === 'group') {
    if (target.id === groupId) return g
    const [first, end] = blockRange(others, target.id)
    if (first === -1) return g
    at = target.place === 'before' ? first : end
  } else {
    at = others.length
  }
  at = Math.max(at, pinnedCount(others))
  return settle(g, [...others.slice(0, at), ...members, ...others.slice(at)])
}

export function applyDrop<W extends Groupable>(
  g: Grouping<W>,
  source: DragSource,
  target: DropTarget,
): Grouping<W> {
  return source.kind === 'workspace'
    ? dropWorkspace(g, source.id, target)
    : dropGroup(g, source.id, target)
}

export function createGroup<W extends Groupable>(
  g: Grouping<W>,
  workspaceId: string,
  group: WorkspaceGroup,
): Grouping<W> {
  if (!g.workspaces.some((w) => w.id === workspaceId)) return g
  const workspaces = setPinned(g.workspaces, workspaceId, false).map((w) =>
    w.id === workspaceId ? withGroup(w, group.id) : w,
  )
  return normalizeGroups({ workspaces, groups: [...g.groups, group] })
}

export function joinGroup<W extends Groupable>(
  g: Grouping<W>,
  workspaceId: string,
  groupId: string,
): Grouping<W> {
  const moving = g.workspaces.find((w) => w.id === workspaceId)
  if (!moving || moving.groupId === groupId) return g
  const members = groupMembers(g.workspaces, groupId)
  const last = members[members.length - 1]
  if (!last) return g
  return dropWorkspace(g, workspaceId, { kind: 'workspace', id: last.id, place: 'after' })
}

export function leaveGroup<W extends Groupable>(g: Grouping<W>, workspaceId: string): Grouping<W> {
  const moving = g.workspaces.find((w) => w.id === workspaceId)
  if (!moving?.groupId) return g
  const others = g.workspaces.filter((w) => w.id !== workspaceId)
  const [first, end] = blockRange(others, moving.groupId)
  const at = first === -1 ? g.workspaces.indexOf(moving) : end
  return normalizeGroups({
    workspaces: [...others.slice(0, at), withGroup(moving, undefined), ...others.slice(at)],
    groups: g.groups,
  })
}

export function deleteGroup<W extends Groupable>(g: Grouping<W>, groupId: string): Grouping<W> {
  if (!g.groups.some((group) => group.id === groupId)) return g
  return {
    workspaces: g.workspaces.map((w) => (w.groupId === groupId ? withGroup(w, undefined) : w)),
    groups: g.groups.filter((group) => group.id !== groupId),
  }
}

export function patchGroup<W extends Groupable>(
  g: Grouping<W>,
  groupId: string,
  patch: { name?: string; color?: WorkspaceGroupColor | null; collapsed?: boolean },
): Grouping<W> {
  const groups = g.groups.map((group) => {
    if (group.id !== groupId) return group
    const { color: _color, collapsed: _collapsed, ...base } = group
    const color = patch.color === undefined ? group.color : (patch.color ?? undefined)
    const collapsed = patch.collapsed ?? group.collapsed
    return {
      ...base,
      name: patch.name ?? group.name,
      ...(color ? { color } : {}),
      ...(collapsed ? { collapsed: true } : {}),
    }
  })
  return { ...g, groups }
}

export function pinWorkspace<W extends Groupable>(
  g: Grouping<W>,
  workspaceId: string,
  pinned: boolean,
): Grouping<W> {
  const workspaces = pinned
    ? g.workspaces.map((w) => (w.id === workspaceId ? withGroup(w, undefined) : w))
    : g.workspaces
  return settle(g, setPinned(workspaces, workspaceId, pinned))
}

export function insertWorkspace<W extends Groupable>(
  g: Grouping<W>,
  workspace: W,
  afterId?: string,
): Grouping<W> {
  const appended = { ...g, workspaces: [...g.workspaces, workspace] }
  if (!workspace.groupId) return appended
  const members = groupMembers(g.workspaces, workspace.groupId)
  const anchor = members.find((w) => w.id === afterId) ?? members[members.length - 1]
  if (!anchor) return appended
  return dropWorkspace(appended, workspace.id, { kind: 'workspace', id: anchor.id, place: 'after' })
}

export function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      source += '.*'
      i++
    } else if (c === '*') {
      source += '[^/]*'
    } else if (c === '?') {
      source += '[^/]'
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

export function matchGroupRule(rules: readonly GroupRule[], workDir: string): string | null {
  const dir = trimSlash(workDir)
  for (const rule of rules) {
    if (globToRegExp(trimSlash(rule.pattern)).test(dir)) return rule.group
  }
  return null
}
