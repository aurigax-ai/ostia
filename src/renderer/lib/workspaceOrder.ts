interface Orderable {
  id: string
  pinned?: boolean
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
