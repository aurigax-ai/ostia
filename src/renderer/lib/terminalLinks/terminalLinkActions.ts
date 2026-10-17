import { currentDict, fmt } from '@/lib/app/useDict'
import { refusalText } from '@/lib/files/fileDrop'
import { pathInTree } from '@/lib/files/fileTree'
import { homeDir } from '@/lib/files/homeDir'
import { openFileAt, reportFileProblem } from '@/lib/files/openFile'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useFileTreeStore } from '@/stores/files/fileTreeStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { OpenPathResult } from '@shared/files/filesApi'
import type { PathLinkTarget } from './linkModifier'
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

function reportOpenProblem(pane: LinkPane, res: OpenPathResult, path: string): void {
  if (res.ok) return
  const d = currentDict()
  reportFileProblem(
    pane.workspaceId,
    res.error === 'program' ? d.terminalLinks.refusedProgram : fmt(d.fileMenu.openFailed, { path }),
  )
}

function showInFiles(pane: LinkPane, path: string): void {
  const root = filesRoot(pane)
  const shown = pathInTree(path, root, homeDir())
  if (shown === null) return
  useFileTreeStore.getState().reveal(root, shown)
  useUIStore.getState().showFiles()
}

function openWithSystem(pane: LinkPane, target: FileLinkTarget): void {
  void window.ostia.terminalLinks
    .openDefault(pane.paneId, target.written)
    .then((res) => reportOpenProblem(pane, res, target.written))
}

function openInOstia(pane: LinkPane, action: FileLinkAction, target: FileLinkTarget): void {
  if (action === 'open-file') openFileAt(target.path, target.line, target.column)
  else if (action === 'admit-file') void admitAndOpen(pane, target)
  else if (action === 'open-folder') openWithSystem(pane, target)
  else showInFiles(pane, target.path)
}

export function activateFileLink(
  pane: LinkPane,
  how: PathLinkTarget,
  action: FileLinkAction,
  target: FileLinkTarget,
): void {
  if (how === 'open') openInOstia(pane, action, target)
  else if (how === 'show') showInFiles(pane, target.path)
  else if (how === 'open-system') openWithSystem(pane, target)
  else {
    void window.ostia.terminalLinks
      .showInFolder(pane.paneId, target.written)
      .then((res) => reportOpenProblem(pane, res, target.written))
  }
}
