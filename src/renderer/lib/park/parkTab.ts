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

export function requestPark(workspaceId: string, paneId: string): void {
  const pane = paneOf(workspaceId, paneId)
  const title = pane?.title ?? ''
  const reason = parkRefusalOf(workspaceId, paneId)
  const park = useParkStore.getState()
  if (reason) park.showNotice({ kind: 'refused', workspaceId, paneId, title, reason })
  else park.openPrompt({ workspaceId, paneId, title })
}

export async function confirmPark(note: string): Promise<void> {
  const park = useParkStore.getState()
  const request = park.prompt
  if (!request) return
  const { workspaceId, paneId, title } = request
  park.closePrompt()
  const outcome = await window.ostia.park.pane(workspaceId, paneId, note)
  if (!outcome.ok) {
    useParkStore
      .getState()
      .showNotice({ kind: 'refused', workspaceId, paneId, title, reason: outcome.reason })
    return
  }
  useLayoutStore.getState().closePane(workspaceId, paneId)
  useParkStore.getState().showNotice({ kind: 'parked', workspaceId, title: outcome.title || title })
}
