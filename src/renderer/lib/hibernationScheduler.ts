import { allPanes, findPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { clampIdleSeconds, clampMaxLive, useSettingsStore } from '../stores/settingsStore'
import { type HibernationCandidate, pickHibernation } from './hibernation'
import { paneActivityAt } from './paneActivity'
import { runningAgentOf } from './paneAgent'
import { resumeWhenIdle } from './resumeFolder'
import { countUsage } from './usageCounts'
import { isPaneVisible, workspaceOfPane } from './workspaceActivity'

export const HIBERNATION_CHECK_MS = 5000
export const WAKE_WAVE_SIZE = 3

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

export async function hibernatePane(workspaceId: string, paneId: string): Promise<boolean> {
  if (isPaneVisible(paneId)) return false
  const stopped = await window.ostia.pty.hibernate(paneId)
  if (stopped) useLayoutStore.getState().setHibernated(workspaceId, paneId, true)
  return stopped
}

export function wakePane(paneId: string, onSettled: () => void = () => {}): boolean {
  const workspaceId = workspaceOfPane(paneId)
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  const pane = layout ? findPane(layout.root, paneId) : null
  if (!workspaceId || !pane?.hibernated) return false
  useLayoutStore.getState().setHibernated(workspaceId, paneId, false)
  countUsage('terminal', 'wake')
  if (!pane.resume) {
    onSettled()
    return true
  }
  window.ostia.pty.reportWaking(paneId, true)
  resumeWhenIdle(
    paneId,
    pane.resume,
    () => {
      window.ostia.pty.reportWaking(paneId, false)
      onSettled()
    },
    onSettled,
  )
  return true
}

const wakeQueue: string[] = []
let wakesInFlight = 0

function wakeSettled(): void {
  wakesInFlight -= 1
  drainWakeQueue()
}

function drainWakeQueue(): void {
  while (wakesInFlight < WAKE_WAVE_SIZE && wakeQueue.length > 0) {
    const paneId = wakeQueue.shift() as string
    wakesInFlight += 1
    if (!wakePane(paneId, wakeSettled)) wakesInFlight -= 1
  }
}

function wakeInWaves(paneIds: string[]): string[] {
  const queued = paneIds.filter((paneId) => !wakeQueue.includes(paneId))
  wakeQueue.push(...queued)
  drainWakeQueue()
  return queued
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

export function resumableAgentPanes(workspaceId: string): string[] {
  return workspacePanes(workspaceId)
    .filter((pane) => pane.hibernated && !pane.resumeFolderMissing)
    .map((pane) => pane.id)
}

export async function hibernateWorkspace(workspaceId: string): Promise<string[]> {
  const done: string[] = []
  for (const paneId of hibernatableAgentPanes(workspaceId)) {
    if (!(await window.ostia.pty.hibernate(paneId))) continue
    useLayoutStore.getState().setHibernated(workspaceId, paneId, true)
    done.push(paneId)
  }
  return done
}

export async function hibernateWorkspaces(workspaceIds: readonly string[]): Promise<string[]> {
  const done: string[] = []
  for (const workspaceId of workspaceIds) done.push(...(await hibernateWorkspace(workspaceId)))
  return done
}

export function resumeWorkspaces(workspaceIds: readonly string[]): string[] {
  return wakeInWaves(workspaceIds.flatMap(resumableAgentPanes))
}

export async function hibernateIdleAgents(now = Date.now()): Promise<string[]> {
  const settings = useSettingsStore.getState().agents.hibernation
  if (!settings.enabled) return []
  const picked = pickHibernation(hibernationCandidates(now), {
    idleSeconds: clampIdleSeconds(settings.idleSeconds),
    maxLiveTerminals: clampMaxLive(settings.maxLiveTerminals),
  })
  const done: string[] = []
  for (const c of picked) {
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
