import { ipcMain } from 'electron'
import type { SandboxMergeRefusal } from '../shared/sandbox'
import type { WorkspaceMergeResult } from '../shared/types'

export interface WorkspaceMergeDeps {
  ownerWindow: (workspaceId: string) => string | undefined
  hasManager: (workspaceId: string) => boolean
  sandboxRefusal: (sourceId: string, targetId: string) => SandboxMergeRefusal | null
  merge: (sourceId: string, targetId: string) => void
}

export function checkMerge(
  deps: Omit<WorkspaceMergeDeps, 'merge'>,
  windowId: string,
  sourceId: unknown,
  targetId: unknown,
): WorkspaceMergeResult {
  if (
    typeof sourceId !== 'string' ||
    typeof targetId !== 'string' ||
    sourceId === targetId ||
    deps.ownerWindow(sourceId) !== windowId ||
    deps.ownerWindow(targetId) !== windowId
  ) {
    return { ok: false, error: 'not-owned' }
  }
  if (deps.hasManager(sourceId) || deps.hasManager(targetId)) return { ok: false, error: 'manager' }
  const refusal = deps.sandboxRefusal(sourceId, targetId)
  return refusal ? { ok: false, error: refusal } : { ok: true }
}

export function registerWorkspaceMergeIpc(deps: WorkspaceMergeDeps): void {
  ipcMain.handle(
    'workspace:merge',
    (e, sourceId: unknown, targetId: unknown): WorkspaceMergeResult => {
      const result = checkMerge(deps, String(e.sender.id), sourceId, targetId)
      if (result.ok) deps.merge(sourceId as string, targetId as string)
      return result
    },
  )
}
