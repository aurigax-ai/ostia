import { currentDict } from '@/lib/app/useDict'
import { focusRightPanel } from '@/lib/panes/rightPanelFocus'
import { useSidePanelStore } from '@/stores/app/sidePanelStore'
import { useUIStore } from '@/stores/app/uiStore'
import { type GitPage, useGitViewStore } from '@/stores/files/gitViewStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

export const GIT_PANEL_ID = 'git'

export function openGit(workspaceId: string, page: GitPage, file?: string): string | null {
  if (page === 'changes') {
    useSidePanelStore.getState().showRight(GIT_PANEL_ID)
    focusRightPanel()
    return null
  }
  useUIStore.getState().showWorkspaces()
  const paneId = useLayoutStore.getState().openGit(workspaceId, currentDict().git.title)
  if (paneId) useGitViewStore.getState().navigate(paneId, page, file)
  return paneId
}
