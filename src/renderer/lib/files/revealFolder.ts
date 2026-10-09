import { findPane } from '@/layout/tree'
import { useFileTreeStore } from '@/stores/fileTreeStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useUIStore } from '@/stores/uiStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'

export interface FollowedFolder {
  cwd: string
  activeFile: string | null
}

export function followedFolder(workspaceId: string | null): FollowedFolder {
  const anchor =
    useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)?.workDir ?? '~'
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  const pane = layout ? findPane(layout.root, layout.activePaneId) : null
  if (pane?.kind === 'editor') return { cwd: anchor, activeFile: pane.filePath ?? null }
  return { cwd: pane?.cwd ?? anchor, activeFile: null }
}

export function treeRoot(
  workspaceId: string | null,
  followed: string,
  shown: { workspaceId: string; dir: string; from: string } | null,
): string {
  return shown && shown.workspaceId === workspaceId && shown.from === followed
    ? shown.dir
    : followed
}

export function revealFolder(workspaceId: string, dir: string): void {
  const tree = useFileTreeStore.getState()
  const followed = followedFolder(workspaceId).cwd
  if (treeRoot(workspaceId, followed, tree.shown) !== dir) tree.show(workspaceId, dir, followed)
  if (useWorkspacesStore.getState().activeWorkspaceId === workspaceId) {
    useUIStore.getState().showFiles()
  }
}
