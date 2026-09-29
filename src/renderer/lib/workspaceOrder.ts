interface Orderable {
  id: string
  pinned?: boolean
}

function withPinned<W extends Orderable>(w: W, pinned: boolean): W {
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

export function moveTo<W extends Orderable>(list: W[], id: string, index: number): W[] {
  const from = list.findIndex((w) => w.id === id)
  if (from === -1) return list
  const moving = list[from]
  const others = list.filter((w) => w.id !== id)
  const pinnedCount = others.filter((w) => w.pinned).length
  const [lo, hi] = moving.pinned ? [0, pinnedCount] : [pinnedCount, others.length]
  const at = Math.min(Math.max(index, lo), hi)
  if (at === from) return list
  return [...others.slice(0, at), moving, ...others.slice(at)]
}

export function moveBy<W extends Orderable>(list: W[], id: string, delta: number): W[] {
  const from = list.findIndex((w) => w.id === id)
  return from === -1 ? list : moveTo(list, id, from + delta)
}
