import { type AgentBusyReason, type HibernateOutcome, isAgentBusyReason } from '@shared/agentWork'
import { allPanes, findPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { clampIdleSeconds, clampMaxLive, useSettingsStore } from '../stores/settingsStore'
import { type HibernationCandidate, planHibernation } from './hibernation'
import { paneActivityAt } from './paneActivity'
import { runningAgentOf } from './paneAgent'
import { resumeWhenIdle } from './resumeFolder'
import { countUsage } from './usageCounts'
import { isPaneVisible, workspaceOfPane } from './workspaceActivity'

export const HIBERNATION_CHECK_MS = 5000

export function hibernationCandidates(now: number): HibernationCandidate[] {
  const out: HibernationCandidate[] = []
  for (const [workspaceId, layout] of Object.entries(useLayoutStore.getState().byWorkspace)) {
    if (!layout) continue
    for (const pane of allPanes(layout.root)) {
      if (pane.kind !== 'terminal' || !pane.resume || pane.hibernated) continue
      const lastActive = paneActivityAt(pane.id)
      out.push({
        paneId: pane.id,
        workspaceId,
        agentRunning: runningAgentOf(pane.id) === pane.resume.agent,
        visible: isPaneVisible(pane.id),
        idleMs: lastActive === undefined ? 0 : now - lastActive,
      })
    }
  }
  return out
}

export type SkippedAgents = Partial<Record<AgentBusyReason, number>>

export interface HibernateReport {
  hibernated: string[]
  skipped: SkippedAgents
}

async function stopPane(workspaceId: string, paneId: string): Promise<HibernateOutcome> {
  const outcome = await window.ostia.pty.hibernate(paneId)
  if (outcome === 'hibernated') useLayoutStore.getState().setHibernated(workspaceId, paneId, true)
  return outcome
}

export async function hibernatePane(workspaceId: string, paneId: string): Promise<boolean> {
  if (isPaneVisible(paneId)) return false
  return (await stopPane(workspaceId, paneId)) === 'hibernated'
}

export function wakePane(paneId: string): boolean {
  const workspaceId = workspaceOfPane(paneId)
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  const pane = layout ? findPane(layout.root, paneId) : null
  if (!workspaceId || !pane?.hibernated) return false
  useLayoutStore.getState().setHibernated(workspaceId, paneId, false)
  countUsage('terminal', 'wake')
  if (pane.resume) {
    window.ostia.pty.reportWaking(paneId, true)
    resumeWhenIdle(paneId, pane.resume, () => window.ostia.pty.reportWaking(paneId, false))
  }
  return true
}

function workspacePanes(workspaceId: string) {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  return layout ? allPanes(layout.root) : []
}

export function hibernatableAgentPanes(workspaceId: string): string[] {
  return workspacePanes(workspaceId)
    .filter(
      (pane) =>
        pane.kind === 'terminal' &&
        pane.resume &&
        !pane.hibernated &&
        runningAgentOf(pane.id) === pane.resume.agent,
    )
    .map((pane) => pane.id)
}

export function hibernatedPanes(workspaceId: string): string[] {
  return workspacePanes(workspaceId)
    .filter((pane) => pane.hibernated)
    .map((pane) => pane.id)
}

export async function hibernateWorkspace(workspaceId: string): Promise<HibernateReport> {
  const report: HibernateReport = { hibernated: [], skipped: {} }
  for (const paneId of hibernatableAgentPanes(workspaceId)) {
    const outcome = await stopPane(workspaceId, paneId)
    if (outcome === 'hibernated') report.hibernated.push(paneId)
    else if (isAgentBusyReason(outcome)) {
      report.skipped[outcome] = (report.skipped[outcome] ?? 0) + 1
    }
  }
  return report
}

export function wakeWorkspace(workspaceId: string): string[] {
  return hibernatedPanes(workspaceId).filter((paneId) => wakePane(paneId))
}

export async function hibernateIdleAgents(now = Date.now()): Promise<string[]> {
  const settings = useSettingsStore.getState().agents.hibernation
  if (!settings.enabled) return []
  const plan = planHibernation(hibernationCandidates(now), {
    idleSeconds: clampIdleSeconds(settings.idleSeconds),
    maxLiveTerminals: clampMaxLive(settings.maxLiveTerminals),
  })
  const done: string[] = []
  for (const c of plan.longestIdleFirst) {
    if (done.length >= plan.excess) break
    if (await hibernatePane(c.workspaceId, c.paneId)) done.push(c.paneId)
  }
  return done
}

export function startHibernation(): () => void {
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    void hibernateIdleAgents().finally(() => {
      busy = false
    })
  }, HIBERNATION_CHECK_MS)
  return () => clearInterval(timer)
}
