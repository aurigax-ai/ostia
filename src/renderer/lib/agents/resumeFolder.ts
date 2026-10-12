import { allPanes, findPane } from '@/layout/tree'
import type { PaneNode } from '@/layout/types'
import { workspaceOfPane } from '@/lib/attention/workspaceActivity'
import { runWhenIdle } from '@/lib/terminal/blockActions'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { type AgentResume, resumeCommand } from '@shared/agents/agentResume'
import { runningAgentOf } from './paneAgent'

export const RESUME_CLAIM_MS = 10_000

const claims = new Map<string, { resume: AgentResume; at: number }>()

function sameSession(a: AgentResume, b: AgentResume): boolean {
  return a.agent === b.agent && a.id === b.id
}

export function claimResume(paneId: string, resume: AgentResume, now = Date.now()): void {
  claims.set(paneId, { resume, at: now })
}

export function clearResumeClaims(): void {
  claims.clear()
}

function claimedBy(pane: PaneNode, resume: AgentResume, now: number): boolean {
  const claim = claims.get(pane.id)
  if (!claim) return false
  if (
    now - claim.at >= RESUME_CLAIM_MS ||
    useBlocksStore.getState().running[pane.id] !== undefined
  ) {
    claims.delete(pane.id)
    return false
  }
  return sameSession(claim.resume, resume)
}

export function resumeHolder(
  paneId: string,
  resume: AgentResume,
  now = Date.now(),
): PaneNode | null {
  for (const layout of Object.values(useLayoutStore.getState().byWorkspace)) {
    for (const pane of layout ? allPanes(layout.root) : []) {
      if (pane.id === paneId) continue
      const live =
        pane.resume !== undefined &&
        sameSession(pane.resume, resume) &&
        runningAgentOf(pane.id) === resume.agent
      if (live || claimedBy(pane, resume, now)) return pane
    }
  }
  return null
}

export function resumeConflict(pane: PaneNode, now = Date.now()): PaneNode | null {
  const resume = pane.resume
  if (pane.kind !== 'terminal' || !resume) return null
  const exposed =
    pane.hibernated === true ||
    pane.resumePending === true ||
    runningAgentOf(pane.id) === resume.agent
  return exposed ? resumeHolder(pane.id, resume, now) : null
}

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
    () => !resumeFolderMissing(paneId) && !resumeHolder(paneId, resume),
    onGiveUp,
    () => {
      claimResume(paneId, resume)
      onTyped?.()
    },
  )
}
