import { type AgentResume, parseAgentResume } from '@shared/agents/agentResume'
import { resumeWhenIdle } from '@/lib/agents/resumeFolder'
import { focusActivePaneWhenReady } from '@/lib/panes/paneFocus'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

export function resumeParked(workspaceId: string, raw: unknown, title: string): boolean {
  const resume: AgentResume | null = parseAgentResume(raw)
  const folder = resume?.cwd
  const layouts = useLayoutStore.getState()
  const layout = layouts.byWorkspace[workspaceId]
  if (!resume || !folder || !layout?.activePaneId) return false
  const tabId = layouts.newTab(workspaceId, layout.activePaneId, 'terminal')
  if (!tabId) return false
  layouts.setSpawnDir(workspaceId, tabId, folder)
  layouts.rename(workspaceId, tabId, title)
  focusActivePaneWhenReady(workspaceId)
  resumeWhenIdle(
    tabId,
    resume,
    () => useLayoutStore.getState().closePane(workspaceId, tabId),
    undefined,
    undefined,
    true,
  )
  return true
}
