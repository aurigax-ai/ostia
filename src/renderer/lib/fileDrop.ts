import type { OpenFileVerdict } from '@shared/openFiles'
import { currentDict, fmt } from '../i18n/useDict'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { droppedPaths } from './dropPaths'
import { startNewWorkspace } from './newWorkspace'
import { openFileTabs, reportFileProblem } from './openFile'

export const FILE_DRAG_ATTRIBUTE = 'data-file-drag'

const FILE_DRAG_IDLE_MS = 400

export function isFileDrag(types: readonly string[]): boolean {
  return types.includes('Files')
}

export function dropPaneId(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined
  return target.closest<HTMLElement>('.pane[data-pane-id]')?.dataset.paneId
}

function refusalText(verdict: OpenFileVerdict & { ok: false }): string {
  return fmt(currentDict().openFile[verdict.error], { path: verdict.path })
}

export async function openDroppedFiles(paths: readonly string[], paneId?: string): Promise<void> {
  if (paths.length === 0) return
  const verdicts = await window.pine.files.admitDropped(
    [...paths],
    useWorkspacesStore.getState().activeWorkspaceId,
  )
  const files = verdicts.flatMap((verdict) => (verdict.ok ? [{ path: verdict.path }] : []))
  if (files.length > 0 && !useWorkspacesStore.getState().activeWorkspaceId) startNewWorkspace()
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  if (workspaceId) openFileTabs(workspaceId, files, paneId)
  for (const verdict of verdicts) {
    if (!verdict.ok) reportFileProblem(workspaceId, refusalText(verdict))
  }
}

export function startFileDropTracking(): () => void {
  const root = document.documentElement
  let idle: ReturnType<typeof setTimeout> | null = null
  const end = (): void => {
    if (idle) clearTimeout(idle)
    idle = null
    root.removeAttribute(FILE_DRAG_ATTRIBUTE)
  }
  const track = (e: DragEvent): boolean => {
    if (!isFileDrag([...(e.dataTransfer?.types ?? [])])) return false
    root.setAttribute(FILE_DRAG_ATTRIBUTE, '')
    if (idle) clearTimeout(idle)
    idle = setTimeout(end, FILE_DRAG_IDLE_MS)
    return true
  }
  const over = (e: DragEvent): void => {
    if (!track(e) || e.defaultPrevented || !e.dataTransfer) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const drop = (e: DragEvent): void => {
    end()
    if (!e.dataTransfer || !isFileDrag([...e.dataTransfer.types]) || e.defaultPrevented) return
    e.preventDefault()
    void openDroppedFiles(droppedPaths(e.dataTransfer), dropPaneId(e.target))
  }
  document.addEventListener('dragenter', track)
  document.addEventListener('dragover', over)
  document.addEventListener('drop', drop)
  return () => {
    end()
    document.removeEventListener('dragenter', track)
    document.removeEventListener('dragover', over)
    document.removeEventListener('drop', drop)
  }
}
