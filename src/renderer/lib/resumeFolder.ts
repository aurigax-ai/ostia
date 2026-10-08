import { type AgentResume, resumeCommand } from '@shared/agentResume'
import { findPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { runWhenIdle } from './blockActions'
import { workspaceOfPane } from './workspaceActivity'

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
