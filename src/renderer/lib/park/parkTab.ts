import { type ParkRefusal, parkRefusal } from '@shared/park/park'
import { runningAgentOf } from '@/lib/agents/paneAgent'
import { findPane } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useParkStore } from '@/stores/workspaces/parkStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

function paneOf(workspaceId: string, paneId: string): PaneNode | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  return layout ? findPane(layout.root, paneId) : null
}

export function parkRefusalOf(workspaceId: string, paneId: string): ParkRefusal | null {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)
  const pane = paneOf(workspaceId, paneId)
  if (!workspace || !pane) return 'unavailable'
  const agent = pane.kind === 'terminal' ? runningAgentOf(pane.id) : null
  return parkRefusal({
    manager: pane.kind === 'manager',
    workspaceKind: workspace.kind,
    sandboxed: useSandboxStore.getState().enabled[workspaceId] === true,
    remote: false,
    locked: useLayoutStore.getState().isLocked(workspaceId, paneId),
    agentRunning: agent !== null && agent === pane.resume?.agent,
    hasResume: pane.resume !== undefined,
    working: useAttentionStore.getState().byPane[paneId]?.state === 'working',
  })
}

export async function requestPark(workspaceId: string, paneId: string): Promise<void> {
  const title = paneOf(workspaceId, paneId)?.title ?? ''
  const park = useParkStore.getState()
  const refusal = parkRefusalOf(workspaceId, paneId)
  if (refusal) {
    park.showNotice({ kind: 'refused', workspaceId, paneId, title, reason: refusal })
    return
  }
  const outcome = await window.ostia.park.pane(
    workspaceId,
    paneId,
    paneOf(workspaceId, paneId)?.titlePinned === true,
  )
  if (!outcome.ok) {
    useParkStore
      .getState()
      .showNotice({ kind: 'refused', workspaceId, paneId, title, reason: outcome.reason })
    return
  }
  useParkStore.getState().showNotice({ kind: 'parked', workspaceId, title: outcome.title || title })
}
