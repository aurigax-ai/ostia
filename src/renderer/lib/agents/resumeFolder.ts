import { type AgentResume, resumeCommand } from '@shared/agents/agentResume'
import { workspaceOfPane } from '@/lib/attention/workspaceActivity'
import { allPanes, findPane } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { runWhenIdle } from '@/lib/terminal/blockActions'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { claudeTrustGate } from './folderTrust'
import { runningAgentOf } from './paneAgent'
import { watchResumeOutcome } from './resumeOutcome'

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

export function resumeClaimEndsAt(paneId: string): number | null {
  const claim = claims.get(paneId)
  if (!claim || useBlocksStore.getState().running[paneId] !== undefined) return null
  return claim.at + RESUME_CLAIM_MS
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
        pane.hibernated !== true &&
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

export function paneResumeHolder(paneId: string): PaneNode | null {
  const workspaceId = workspaceOfPane(paneId)
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  const resume = layout ? findPane(layout.root, paneId)?.resume : undefined
  return resume ? resumeHolder(paneId, resume) : null
}

export function resumeFolderMissing(paneId: string): string | undefined {
  const workspaceId = workspaceOfPane(paneId)
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  return layout ? findPane(layout.root, paneId)?.resumeFolderMissing : undefined
}

export async function claimAcrossWindows(
  paneId: string,
  resume: AgentResume,
): Promise<string | null> {
  const verdict = await window.ostia.agentSession.claimResume(paneId, resume)
  return verdict.ok ? null : verdict.holder
}

export function resumeWhenIdle(
  paneId: string,
  resume: AgentResume,
  onGiveUp?: (held: boolean) => void,
  onTyped?: () => void,
  timeoutMs?: number | null,
  askTrust = false,
  onHold?: () => void,
): () => void {
  let heldElsewhere = false
  const allowed = async (): Promise<boolean> => {
    if (resumeFolderMissing(paneId) || resumeHolder(paneId, resume)) return false
    if (askTrust && !(await claudeTrustGate(paneId, resume.agent, onHold, resume.id))) {
      return false
    }
    if (resumeFolderMissing(paneId) || resumeHolder(paneId, resume)) return false
    claimResume(paneId, resume)
    heldElsewhere = (await claimAcrossWindows(paneId, resume)) !== null
    return !heldElsewhere
  }
  return runWhenIdle(
    paneId,
    resumeCommand(resume),
    timeoutMs,
    allowed,
    () => {
      claims.delete(paneId)
      onGiveUp?.(heldElsewhere || resumeHolder(paneId, resume) !== null)
    },
    () => {
      claimResume(paneId, resume)
      watchResumeOutcome(paneId, resume)
      onTyped?.()
    },
  )
}
