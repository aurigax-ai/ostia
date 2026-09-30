import { resumeCommand } from '@shared/agentResume'
import { allPanes, findPane } from '../layout/tree'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { clampIdleSeconds, clampMaxLive, useSettingsStore } from '../stores/settingsStore'
import { runWhenIdle } from './blockActions'
import { type HibernationCandidate, commandAgent, pickHibernation } from './hibernation'
import { paneActivityAt } from './paneActivity'
import { isPaneVisible, workspaceOfPane } from './workspaceActivity'

export const HIBERNATION_CHECK_MS = 5000

function runningCommand(paneId: string): string | null {
  const blocks = useBlocksStore.getState()
  const id = blocks.running[paneId]
  if (!id) return null
  return blocks.byPane[paneId]?.find((b) => b.id === id)?.command ?? null
}

export function hibernationCandidates(now: number): HibernationCandidate[] {
  const out: HibernationCandidate[] = []
  for (const [workspaceId, layout] of Object.entries(useLayoutStore.getState().byWorkspace)) {
    if (!layout) continue
    for (const pane of allPanes(layout.root)) {
      if (pane.kind !== 'terminal' || !pane.resume || pane.hibernated) continue
      const command = runningCommand(pane.id)
      const lastActive = paneActivityAt(pane.id)
      out.push({
        paneId: pane.id,
        workspaceId,
        agentRunning: command !== null && commandAgent(command) === pane.resume.agent,
        visible: isPaneVisible(pane.id),
        idleMs: lastActive === undefined ? 0 : now - lastActive,
      })
    }
  }
  return out
}

export async function hibernatePane(workspaceId: string, paneId: string): Promise<boolean> {
  if (isPaneVisible(paneId)) return false
  const stopped = await window.pine.pty.hibernate(paneId)
  if (stopped) useLayoutStore.getState().setHibernated(workspaceId, paneId, true)
  return stopped
}

export function wakePane(paneId: string): boolean {
  const workspaceId = workspaceOfPane(paneId)
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  const pane = layout ? findPane(layout.root, paneId) : null
  if (!workspaceId || !pane?.hibernated) return false
  useLayoutStore.getState().setHibernated(workspaceId, paneId, false)
  if (pane.resume) runWhenIdle(paneId, resumeCommand(pane.resume))
  return true
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
