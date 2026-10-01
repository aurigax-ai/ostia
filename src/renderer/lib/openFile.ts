import type { FileTarget } from '@shared/openFiles'
import { useEditorRevealStore } from '../stores/editorRevealStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { startNewWorkspace } from './newWorkspace'

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
  window.pine.notifications.post({ paneId, kind: 'error', title: message, desktop: false })
}
