import { findPane } from '@/layout/tree'
import { workspaceOfPane } from '@/lib/attention/workspaceActivity'
import { runWhenIdle } from '@/lib/terminal/blockActions'
import { useLayoutStore } from '@/stores/layoutStore'
import { type AgentResume, resumeCommand } from '@shared/agents/agentResume'

export function resumeFolderMissing(paneId: string): string | undefined {
  const workspaceId = workspaceOfPane(paneId)
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  return layout ? findPane(layout.root, paneId)?.resumeFolderMissing : undefined
}

export function resumeWhenIdle(
  paneId: string,
  resume: AgentResume,
  onGiveUp?: () => void,
  onTyped?: () => void,
): () => void {
  return runWhenIdle(
    paneId,
    resumeCommand(resume),
    undefined,
    () => !resumeFolderMissing(paneId),
    onGiveUp,
    onTyped,
  )
}
