import { workspaceOfPane } from '@/lib/attention/workspaceActivity'
import { findPane } from '@/lib/layout/tree'
import { runWhenIdle } from '@/lib/terminal/blockActions'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { ResumeFailure } from '@shared/agents/agentResume'
import { newSessionCommand } from '@shared/agents/agentResume'
import { resumeWhenIdle } from './resumeFolder'

function failureOf(paneId: string): { workspaceId: string; failure: ResumeFailure } | null {
  const workspaceId = workspaceOfPane(paneId)
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  const failure = layout ? findPane(layout.root, paneId)?.resumeFailed : undefined
  return workspaceId && failure ? { workspaceId, failure } : null
}

export function retryResume(paneId: string): void {
  const found = failureOf(paneId)
  if (!found) return
  useLayoutStore.getState().setResume(found.workspaceId, paneId, found.failure.resume)
  resumeWhenIdle(paneId, found.failure.resume)
}

export function startNewSession(paneId: string): void {
  const found = failureOf(paneId)
  if (!found) return
  useLayoutStore.getState().clearResumeFailure(found.workspaceId, paneId)
  runWhenIdle(paneId, newSessionCommand(found.failure.resume.agent))
}

export function dismissResumeFailure(paneId: string): void {
  const found = failureOf(paneId)
  if (found) useLayoutStore.getState().clearResumeFailure(found.workspaceId, paneId)
}
