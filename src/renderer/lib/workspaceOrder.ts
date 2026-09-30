import type { NewWorkspacePlacement } from '../stores/settingsStore'

interface Orderable {
  id: string
  pinned?: boolean
}

export function insertIndex<W extends Orderable>(
  list: W[],
  placement: NewWorkspacePlacement,
  activeId: string | null,
): number {
  const pinnedCount = list.filter((w) => w.pinned).length
  if (placement === 'top') return pinnedCount
  if (placement === 'afterCurrent') {
    const at = list.findIndex((w) => w.id === activeId)
    return at === -1 ? list.length : Math.max(at + 1, pinnedCount)
  }
  return list.length
}

export function withPinned<W extends Orderable>(w: W, pinned: boolean): W {
  if (Boolean(w.pinned) === pinned) return w
  const { pinned: _old, ...rest } = w
  return (pinned ? { ...rest, pinned: true } : rest) as W
}

export function setPinned<W extends Orderable>(list: W[], id: string, pinned: boolean): W[] {
  const current = list.find((w) => w.id === id)
  if (!current || Boolean(current.pinned) === pinned) return list
  const others = list.filter((w) => w.id !== id)
  const pinnedCount = others.filter((w) => w.pinned).length
  return [
    ...others.slice(0, pinnedCount),
    withPinned(current, pinned),
    ...others.slice(pinnedCount),
  ]
}
