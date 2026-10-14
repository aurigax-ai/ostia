import { currentDict, fmt } from '@/i18n/useDict'
import { findPane } from '@/layout/tree'
import type { PaneNode } from '@/layout/types'
import { runWhenIdle } from '@/lib/terminal/blockActions'
import { focusActivePaneWhenReady } from '@/lib/terminal/focusNewTerminal'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useTabSleepNoticeStore } from '@/stores/workspaces/tabSleepNoticeStore'
import { type AgentResume, forkCommand } from '@shared/agents/agentResume'
import { runningAgentOf } from './paneAgent'
import { resumeFolderMissing } from './resumeFolder'

export function forkableResume(pane: PaneNode): AgentResume | null {
  const resume = pane.resume
  if (pane.kind !== 'terminal' || !resume) return null
  return pane.hibernated === true || runningAgentOf(pane.id) === resume.agent ? resume : null
}

function forkTitle(pane: PaneNode, resume: AgentResume): string {
  const d = currentDict()
  const title = pane.defaultTitle ? d.agentSession[resume.agent] : pane.title
  return fmt(d.pane.forkTitle, { title })
}

function refuseMissingFolder(resume: AgentResume, path: string): void {
  useTabSleepNoticeStore.getState().show({ kind: 'forkFolderMissing', agent: resume.agent, path })
}

export function forkConversation(workspaceId: string, paneId: string): string | null {
  const layouts = useLayoutStore.getState()
  const layout = layouts.byWorkspace[workspaceId]
  const pane = layout ? findPane(layout.root, paneId) : null
  const resume = pane ? forkableResume(pane) : null
  if (!pane || !resume) return null
  if (pane.resumeFolderMissing) {
    refuseMissingFolder(resume, pane.resumeFolderMissing)
    return null
  }
  const forkId = layouts.newTab(workspaceId, paneId, 'terminal')
  if (!forkId) return null
  const folder = resume.cwd ?? pane.cwd
  if (folder) layouts.setSpawnDir(workspaceId, forkId, folder)
  layouts.rename(workspaceId, forkId, forkTitle(pane, resume))
  focusActivePaneWhenReady(workspaceId)
  runWhenIdle(
    forkId,
    forkCommand(resume),
    undefined,
    () => !resumeFolderMissing(forkId),
    () => {
      const missing = resumeFolderMissing(forkId)
      if (!missing) return
      useLayoutStore.getState().closePane(workspaceId, forkId)
      refuseMissingFolder(resume, missing)
    },
  )
  return forkId
}
