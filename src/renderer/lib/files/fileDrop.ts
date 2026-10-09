import { currentDict, fmt } from '@/i18n/useDict'
import { startNewWorkspace } from '@/lib/workspaces/newWorkspace'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import type { OpenFileVerdict } from '@shared/files/openFiles'
import { openFileTabs, reportFileProblem } from './openFile'

export const FILE_DRAG_ATTRIBUTE = 'data-file-drag'

const POINTER_BACK_EVENTS = ['mousemove', 'mousedown', 'wheel'] as const

export function isFileDrag(types: readonly string[]): boolean {
  return types.includes('Files')
}

export function dropPaneId(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined
  return target.closest<HTMLElement>('.pane[data-pane-id]')?.dataset.paneId
}

export function refusalText(verdict: OpenFileVerdict & { ok: false }): string {
  return fmt(currentDict().openFile[verdict.error], { path: verdict.path })
}

export async function openDroppedFiles(dropped: readonly File[], paneId?: string): Promise<void> {
  if (dropped.length === 0) return
  const verdicts = await window.ostia.files.admitDropped(
    [...dropped],
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
  const end = (): void => root.removeAttribute(FILE_DRAG_ATTRIBUTE)
  const track = (e: DragEvent): boolean => {
    if (!isFileDrag([...(e.dataTransfer?.types ?? [])])) return false
    root.setAttribute(FILE_DRAG_ATTRIBUTE, '')
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
    void openDroppedFiles([...e.dataTransfer.files], dropPaneId(e.target))
  }
  document.addEventListener('dragenter', track)
  document.addEventListener('dragover', over)
  document.addEventListener('drop', drop)
  for (const type of POINTER_BACK_EVENTS) document.addEventListener(type, end, true)
  return () => {
    end()
    document.removeEventListener('dragenter', track)
    document.removeEventListener('dragover', over)
    document.removeEventListener('drop', drop)
    for (const type of POINTER_BACK_EVENTS) document.removeEventListener(type, end, true)
  }
}
