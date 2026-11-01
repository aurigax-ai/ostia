import { type AgentResume, canFork, forkCommand } from '@shared/agents/agentResume'
import { currentDict, fmt } from '@/lib/app/useDict'
import { findPane } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { focusActivePaneWhenReady } from '@/lib/panes/paneFocus'
import { runWhenIdle } from '@/lib/terminal/blockActions'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useTabSleepNoticeStore } from '@/stores/workspaces/tabSleepNoticeStore'
import { claudeTrustGate } from './folderTrust'
import { runningAgentOf } from './paneAgent'
import { resumeFolderMissing } from './resumeFolder'

export function forkableResume(pane: PaneNode): AgentResume | null {
  const resume = pane.resume
  if (pane.kind !== 'terminal' || !resume || !canFork(resume.agent)) return null
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
    () => (resumeFolderMissing(forkId) ? false : claudeTrustGate(forkId, resume.agent)),
    () => {
      const missing = resumeFolderMissing(forkId)
      if (!missing) return
      useLayoutStore.getState().closePane(workspaceId, forkId)
      refuseMissingFolder(resume, missing)
    },
  )
  return forkId
}
