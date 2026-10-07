import { useFileTreeStore } from '../stores/fileTreeStore'
import { useSandboxStore } from '../stores/sandboxStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { refusalText } from './fileDrop'
import { pathInTree } from './fileTree'
import { homeDir } from './homeDir'
import { openFileAt, reportFileProblem } from './openFile'
import type { FileLinkAction } from './terminalFileLinks'

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

async function admitAndOpen(
  pane: LinkPane,
  path: string,
  line?: number,
  column?: number,
): Promise<void> {
  const verdict = await window.ostia.terminalLinks.admit(pane.paneId, path)
  if (!verdict) return
  if (verdict.ok) openFileAt(verdict.path, line, column)
  else reportFileProblem(pane.workspaceId, refusalText(verdict))
}

export function activateFileLink(
  pane: LinkPane,
  action: FileLinkAction,
  path: string,
  line?: number,
  column?: number,
): void {
  if (action === 'open-file') {
    openFileAt(path, line, column)
  } else if (action === 'admit-file') {
    void admitAndOpen(pane, path, line, column)
  } else if (action === 'open-folder') {
    void window.ostia.terminalLinks.openFolder(pane.paneId, path)
  } else {
    const root = filesRoot(pane)
    const shown = pathInTree(path, root, homeDir())
    if (shown === null) return
    useFileTreeStore.getState().reveal(root, shown)
    useUIStore.getState().showFiles()
  }
}
