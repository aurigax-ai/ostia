import { currentDict } from '@/i18n/useDict'
import { type GitPage, useGitViewStore } from '@/stores/gitViewStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useUIStore } from '@/stores/uiStore'

export function openGit(workspaceId: string, page: GitPage, file?: string): string | null {
  useUIStore.getState().showWorkspaces()
  const paneId = useLayoutStore.getState().openGit(workspaceId, currentDict().git.title)
  if (paneId) useGitViewStore.getState().navigate(paneId, page, file)
  return paneId
}
