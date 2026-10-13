import { useEffect } from 'react'

export type CoreFeature = 'git' | 'ports'

const counts: Record<CoreFeature, Map<string, number>> = { git: new Map(), ports: new Map() }
const queued = new Set<CoreFeature>()
const sent: Record<CoreFeature, string> = { git: '', ports: '' }

export function watchedWorkspaces(feature: CoreFeature): string[] {
  return [...counts[feature].keys()].sort()
}

function flush(feature: CoreFeature): void {
  queued.delete(feature)
  const ids = watchedWorkspaces(feature)
  const key = ids.join('\u0000')
  if (key === sent[feature]) return
  sent[feature] = key
  window.ostia?.[feature]?.watch(ids)
}

function queue(feature: CoreFeature): void {
  if (queued.has(feature)) return
  queued.add(feature)
  queueMicrotask(() => flush(feature))
}

export function watchWorkspace(feature: CoreFeature, workspaceId: string): () => void {
  const map = counts[feature]
  map.set(workspaceId, (map.get(workspaceId) ?? 0) + 1)
  queue(feature)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (map.get(workspaceId) ?? 1) - 1
    if (left > 0) map.set(workspaceId, left)
    else map.delete(workspaceId)
    queue(feature)
  }
}

export function resetCoreWatch(): void {
  for (const feature of ['git', 'ports'] as const) {
    counts[feature].clear()
    queued.delete(feature)
    sent[feature] = ''
  }
}

export function useCoreWatch(
  feature: CoreFeature,
  workspaceId: string | null | undefined,
  shown = true,
): void {
  useEffect(() => {
    if (!shown || !workspaceId) return
    return watchWorkspace(feature, workspaceId)
  }, [feature, workspaceId, shown])
}

export function useCoreWatchAll(
  feature: CoreFeature,
  workspaceIds: readonly string[],
  shown = true,
): void {
  const key = workspaceIds.join('\u0000')
  useEffect(() => {
    if (!shown || key === '') return
    const releases = key.split('\u0000').map((id) => watchWorkspace(feature, id))
    return () => {
      for (const release of releases) release()
    }
  }, [feature, key, shown])
}
