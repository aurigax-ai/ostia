const seeds = new Map<string, Map<string, string>>()

export function seedSplitTab(workspaceId: string, name: string, paneId: string): void {
  const named = seeds.get(workspaceId) ?? new Map<string, string>()
  named.set(name, paneId)
  seeds.set(workspaceId, named)
}

export function splitTabSeed(workspaceId: string, name: string): string | undefined {
  return seeds.get(workspaceId)?.get(name)
}

export function forgetSplitTabSeeds(paneIds: Iterable<string>): void {
  const gone = new Set(paneIds)
  for (const named of seeds.values()) {
    for (const [name, paneId] of named) if (gone.has(paneId)) named.delete(name)
  }
}
