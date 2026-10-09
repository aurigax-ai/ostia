import { currentDict } from '@/i18n/useDict'
import { useUIStore } from '@/stores/app/uiStore'
import { type GitPage, useGitViewStore } from '@/stores/files/gitViewStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

export function openGit(workspaceId: string, page: GitPage, file?: string): string | null {
  useUIStore.getState().showWorkspaces()
  const paneId = useLayoutStore.getState().openGit(workspaceId, currentDict().git.title)
  if (paneId) useGitViewStore.getState().navigate(paneId, page, file)
  return paneId
}
