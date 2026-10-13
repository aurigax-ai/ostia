const MAX_WATCHED = 500

export class WatchSets {
  private byWindow = new Map<string, ReadonlySet<string>>()

  set(windowId: string, raw: unknown): boolean {
    const ids = Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === 'string' && id !== '').slice(0, MAX_WATCHED)
      : []
    const next = new Set(ids)
    const previous = this.byWindow.get(windowId)
    const same =
      (previous?.size ?? 0) === next.size && [...next].every((id) => previous?.has(id) === true)
    if (same) return false
    if (next.size === 0) this.byWindow.delete(windowId)
    else this.byWindow.set(windowId, next)
    return true
  }

  drop(windowId: string): boolean {
    return this.byWindow.delete(windowId)
  }

  get empty(): boolean {
    return this.byWindow.size === 0
  }

  union(): Set<string> {
    const all = new Set<string>()
    for (const ids of this.byWindow.values()) for (const id of ids) all.add(id)
    return all
  }

  windows(): [string, ReadonlySet<string>][] {
    return [...this.byWindow]
  }
}
