import { isEqual } from 'es-toolkit'
import type { OriginAgents } from '@shared/types'
import { useOriginAgentsStore } from '../stores/originAgentsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'

export function originWorkspaceId(workspace: {
  id: string
  origin?: { workspaceId: string }
}): string | null {
  const origin = workspace.origin?.workspaceId
  return origin && origin !== workspace.id ? origin : null
}

function detachedWorkspaceIds(): string[] {
  return useWorkspacesStore
    .getState()
    .workspaces.filter((w) => originWorkspaceId(w) !== null)
    .map((w) => w.id)
}

let refreshSeq = 0

export async function refreshOriginAgents(): Promise<void> {
  refreshSeq += 1
  const seq = refreshSeq
  const ids = detachedWorkspaceIds()
  const found = await Promise.all(
    ids.map((id) => window.pine.windows.originAgents(id).catch(() => null)),
  )
  if (seq !== refreshSeq) return
  const byWorkspace: Record<string, OriginAgents | null> = {}
  ids.forEach((id, i) => {
    byWorkspace[id] = found[i]
  })
  const current = useOriginAgentsStore.getState().byWorkspace
  if (!isEqual(current, byWorkspace)) {
    useOriginAgentsStore.getState().setAll(byWorkspace)
  }
}

export function startOriginAgentsSync(): () => void {
  let known = detachedWorkspaceIds().join('\n')
  void refreshOriginAgents()
  const offs = [
    window.pine.windows.onOriginAgentsChanged(() => void refreshOriginAgents()),
    useWorkspacesStore.subscribe(() => {
      const next = detachedWorkspaceIds().join('\n')
      if (next === known) return
      known = next
      void refreshOriginAgents()
    }),
  ]
  return () => {
    for (const off of offs) off()
  }
}
