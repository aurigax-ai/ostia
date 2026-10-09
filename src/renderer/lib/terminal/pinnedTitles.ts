const pinned = new Set<string>()

export function pinTitle(paneId: string): void {
  pinned.add(paneId)
}

export function isTitlePinned(paneId: string): boolean {
  return pinned.has(paneId)
}

export function resetPinnedTitles(): void {
  pinned.clear()
}
