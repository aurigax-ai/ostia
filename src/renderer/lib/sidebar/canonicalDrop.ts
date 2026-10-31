import {
  applyDrop,
  type DragSource,
  type DropTarget,
  type Groupable,
  type Grouping,
  toBlocks,
} from './workspaceGroups'

function layoutKey<W extends Groupable>(g: Grouping<W>): string {
  return g.workspaces.map((w) => `${w.id}:${w.groupId ?? ''}:${w.pinned ? 1 : 0}`).join(',')
}

function blockTarget<W extends Groupable>(
  block: { group: { id: string } | null; workspaces: W[] },
  place: 'before' | 'after',
): DropTarget {
  return block.group
    ? { kind: 'group', id: block.group.id, place }
    : { kind: 'workspace', id: block.workspaces[0].id, place }
}

function memberCandidates<W extends Groupable>(next: Grouping<W>, moved: W): DropTarget[] {
  const groupId = moved.groupId as string
  const inside: DropTarget = { kind: 'group', id: groupId, place: 'inside' }
  if (next.groups.find((group) => group.id === groupId)?.collapsed) return [inside]
  const members = next.workspaces.filter((w) => w.groupId === groupId)
  const at = members.indexOf(moved)
  const after = members[at + 1]
  const before = members[at - 1]
  const candidates: DropTarget[] = []
  if (after) candidates.push({ kind: 'workspace', id: after.id, place: 'before' })
  if (before) candidates.push({ kind: 'workspace', id: before.id, place: 'after' })
  return [...candidates, inside]
}

function blockCandidates<W extends Groupable>(next: Grouping<W>, firstId: string): DropTarget[] {
  const blocks = toBlocks(next)
  const at = blocks.findIndex((b) => b.workspaces[0]?.id === firstId)
  const following = blocks[at + 1]
  if (following) return [blockTarget(following, 'before')]
  const preceding = blocks[at - 1]
  return preceding ? [blockTarget(preceding, 'after'), { kind: 'end' }] : [{ kind: 'end' }]
}

function candidatesFor<W extends Groupable>(next: Grouping<W>, source: DragSource): DropTarget[] {
  if (source.kind === 'group') {
    const first = next.workspaces.find((w) => w.groupId === source.id)
    return first ? blockCandidates(next, first.id) : []
  }
  const moved = next.workspaces.find((w) => w.id === source.id)
  if (!moved) return []
  return moved.groupId ? memberCandidates(next, moved) : blockCandidates(next, moved.id)
}

export function canonicalDrop<W extends Groupable>(
  g: Grouping<W>,
  source: DragSource,
  target: DropTarget,
): DropTarget | null {
  const next = applyDrop(g, source, target)
  const landing = layoutKey(next)
  if (landing === layoutKey(g)) return null
  return (
    candidatesFor(next, source).find(
      (candidate) => layoutKey(applyDrop(g, source, candidate)) === landing,
    ) ?? target
  )
}
