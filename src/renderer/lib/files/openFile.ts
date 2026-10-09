import { signalPane } from '@/lib/attention/workspaceActivity'
import { openKeepingFocus } from '@/lib/panes/callerFocus'
import { startNewWorkspace } from '@/lib/workspaces/newWorkspace'
import { useEditorRevealStore } from '@/stores/editorRevealStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import type { FileTarget, OpenPlacement, OpenedPane } from '@shared/files/openFiles'

export function openFileInWorkspace(path: string): void {
  if (!useWorkspacesStore.getState().activeWorkspaceId) startNewWorkspace()
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  if (workspaceId) useLayoutStore.getState().openFile(workspaceId, path)
}

export function openFileBeside(path: string): void {
  if (!useWorkspacesStore.getState().activeWorkspaceId) startNewWorkspace()
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  if (workspaceId) useLayoutStore.getState().openFileBeside(workspaceId, path)
}

export function openTerminalIn(dir: string): void {
  if (!useWorkspacesStore.getState().activeWorkspaceId) startNewWorkspace()
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  if (workspaceId) useLayoutStore.getState().openTerminalTab(workspaceId, dir)
}

export function openFileAt(path: string, line?: number, column?: number): void {
  if (line) useEditorRevealStore.getState().request(path, { line, column: column ?? 1 })
  openFileInWorkspace(path)
}

function requestReveal(file: FileTarget): void {
  if (!file.line) return
  useEditorRevealStore.getState().request(file.path, { line: file.line, column: file.column ?? 1 })
}

export function openFileTabs(workspaceId: string, files: FileTarget[], paneId?: string): void {
  files.forEach((file, index) => {
    requestReveal(file)
    useLayoutStore.getState().openFileTab(workspaceId, file.path, index === 0 ? paneId : undefined)
  })
}

export function openRequestedFiles(
  workspaceId: string,
  files: FileTarget[],
  paneId?: string,
): void {
  if (files.length !== 1) {
    openFileTabs(workspaceId, files, paneId)
    return
  }
  requestReveal(files[0])
  useLayoutStore.getState().openFile(workspaceId, files[0].path)
}

export function reportFileProblem(workspaceId: string | null, message: string): void {
  const paneId = workspaceId
    ? useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId
    : undefined
  if (!paneId) {
    console.error(`[files] ${message}`)
    return
  }
  window.ostia.notifications.post({ paneId, kind: 'error', title: message, desktop: false })
}

export function markOpenedQuietly(paneId: string, title: string): void {
  signalPane(paneId, { type: 'notify', message: title, waiting: false, at: Date.now() })
}

export function openFilesQuietly(workspaceId: string, files: FileTarget[], paneId?: string): void {
  openKeepingFocus(() => {
    let beside = paneId
    for (const file of files) {
      requestReveal(file)
      const opened = useLayoutStore.getState().openFileTab(workspaceId, file.path, beside, true)
      if (!opened) continue
      markOpenedQuietly(opened, file.path.split('/').pop() || file.path)
      beside = opened
    }
  })
}

export interface PlacedOpen {
  placement: OpenPlacement
  quiet: boolean
  fresh: boolean
}

export function openPlaced(
  workspaceId: string,
  files: FileTarget[],
  paneId: string | undefined,
  how: PlacedOpen,
): OpenedPane[] {
  const opened: OpenedPane[] = []
  const place = (): void => {
    let beside = paneId
    for (const file of files) {
      requestReveal(file)
      const layout = useLayoutStore.getState()
      const pane =
        how.placement === 'tab' || opened.length > 0
          ? layout.openFileTab(workspaceId, file.path, beside, how.quiet, how.fresh)
          : layout.openFileSplit(workspaceId, file.path, beside, how.placement, how.quiet)
      if (!pane) continue
      if (how.quiet) markOpenedQuietly(pane, file.path.split('/').pop() || file.path)
      opened.push({ path: file.path, paneId: pane })
      beside = pane
    }
  }
  if (how.quiet) openKeepingFocus(place)
  else place()
  return opened
}
