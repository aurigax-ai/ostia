import { parentOf, pathInTree } from '@/lib/files/fileTree'
import { homeDir } from '@/lib/files/homeDir'
import { findPane } from '@/lib/layout/tree'
import { useUIStore } from '@/stores/app/uiStore'
import { useFileTreeStore } from '@/stores/files/fileTreeStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

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

export function revealFile(workspaceId: string, path: string): void {
  const tree = useFileTreeStore.getState()
  const followed = followedFolder(workspaceId).cwd
  let root = treeRoot(workspaceId, followed, tree.shown)
  if (pathInTree(path, root, homeDir()) === null) {
    root = parentOf(path)
    tree.show(workspaceId, root, followed)
  }
  tree.reveal(root, pathInTree(path, root, homeDir()) ?? path)
  if (useWorkspacesStore.getState().activeWorkspaceId === workspaceId) {
    useUIStore.getState().showFiles()
  }
}
