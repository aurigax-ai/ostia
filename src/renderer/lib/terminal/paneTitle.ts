import { useLayoutStore } from '@/stores/layoutStore'
import { isTitlePinned } from './pinnedTitles'
import { terminalTitle } from './terminalTitle'

export function commitProgramTitle(workspaceId: string, paneId: string, title: string): void {
  if (isTitlePinned(paneId)) return
  useLayoutStore.getState().setTitle(workspaceId, paneId, title)
}

export function commitShellTitle(
  workspaceId: string,
  paneId: string,
  shell: string | undefined,
): void {
  const title = terminalTitle(shell ?? '')
  if (!title || isTitlePinned(paneId)) return
  useLayoutStore.getState().setDefaultTitle(workspaceId, paneId, title)
}
