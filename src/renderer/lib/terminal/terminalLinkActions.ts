import { refusalText } from '@/lib/files/fileDrop'
import { pathInTree } from '@/lib/files/fileTree'
import { homeDir } from '@/lib/files/homeDir'
import { openFileAt, reportFileProblem } from '@/lib/files/openFile'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useFileTreeStore } from '@/stores/files/fileTreeStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { FileLinkAction, FileLinkTarget } from './terminalFileLinks'

export interface LinkPane {
  workspaceId: string
  paneId: string
  cwd: string | null
}

function filesRoot(pane: LinkPane): string {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === pane.workspaceId)
  return pane.cwd ?? workspace?.workDir ?? '~'
}

export function linksConfinedOnly(pane: LinkPane): boolean {
  const { enabled, paneSandboxed } = useSandboxStore.getState()
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === pane.workspaceId)
  return (
    workspace?.kind === 'scratch' ||
    enabled[pane.workspaceId] === true ||
    paneSandboxed[pane.paneId] === true
  )
}

export function linkRevealable(pane: LinkPane, path: string): boolean {
  return pathInTree(path, filesRoot(pane), homeDir()) !== null
}

async function admitAndOpen(pane: LinkPane, target: FileLinkTarget): Promise<void> {
  const verdict = await window.ostia.terminalLinks.admit(pane.paneId, target.written)
  if (!verdict) return
  if (verdict.ok) openFileAt(verdict.path, target.line, target.column)
  else reportFileProblem(pane.workspaceId, refusalText(verdict))
}

export function activateFileLink(
  pane: LinkPane,
  action: FileLinkAction,
  target: FileLinkTarget,
): void {
  if (action === 'open-file') {
    openFileAt(target.path, target.line, target.column)
  } else if (action === 'admit-file') {
    void admitAndOpen(pane, target)
  } else if (action === 'open-folder') {
    void window.ostia.terminalLinks.openFolder(pane.paneId, target.written)
  } else {
    const root = filesRoot(pane)
    const shown = pathInTree(target.path, root, homeDir())
    if (shown === null) return
    useFileTreeStore.getState().reveal(root, shown)
    useUIStore.getState().showFiles()
  }
}
