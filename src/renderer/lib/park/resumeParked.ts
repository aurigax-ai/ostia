import { type AgentResume, parseAgentResume } from '@shared/agents/agentResume'
import type { ResumeFailReason } from '@shared/park/park'
import { commands } from '@/commands/registry'
import { resumeFolderMissing, resumeWhenIdle } from '@/lib/agents/resumeFolder'
import { focusActivePaneWhenReady } from '@/lib/panes/paneFocus'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useParkStore } from '@/stores/workspaces/parkStore'

async function openTab(workspaceId: string): Promise<string | null> {
  const layouts = useLayoutStore.getState()
  const layout = layouts.byWorkspace[workspaceId]
  if (layout) {
    return layout.activePaneId ? layouts.newTab(workspaceId, layout.activePaneId, 'terminal') : null
  }
  await commands.execWith({ activeWorkspaceId: workspaceId, activePaneId: null }, 'tab.new')
  return useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId ?? null
}

export async function resumeParked(
  workspaceId: string,
  raw: unknown,
  title: string,
): Promise<boolean> {
  const resume: AgentResume | null = parseAgentResume(raw)
  const folder = resume?.cwd
  if (!resume || !folder) return false
  const tabId = await openTab(workspaceId)
  if (!tabId) return false
  const layouts = useLayoutStore.getState()
  layouts.setSpawnDir(workspaceId, tabId, folder)
  if (title) layouts.rename(workspaceId, tabId, title)
  focusActivePaneWhenReady(workspaceId)
  resumeWhenIdle(
    tabId,
    resume,
    (held) => {
      const reason: ResumeFailReason = held
        ? 'running-elsewhere'
        : resumeFolderMissing(tabId)
          ? 'folder-missing'
          : 'not-started'
      useParkStore.getState().showNotice({
        kind: 'resumeFailed',
        workspaceId,
        paneId: tabId,
        title: title || resume.agent,
        reason,
      })
    },
    undefined,
    undefined,
    true,
  )
  return true
}
