import { ipcMain } from 'electron'
import type { PaneMoveResult } from '../shared/types'
import { crossesSandbox } from './windowBook'

export interface MovingPane {
  windowId: string
  workspaceId: string
  manager?: true
}

export interface PaneMoveDeps {
  ownerWindow: (workspaceId: string) => string | undefined
  paneOf: (paneId: string) => MovingPane | undefined
  hasManager: (workspaceId: string) => boolean
  isSandboxed: (workspaceId: string) => boolean
  isScratch: (workspaceId: string) => boolean
  movePanes: (paneIds: string[], sourceId: string, targetId: string) => void
  moveWorkspace: (sourceId: string, targetId: string) => void
}

const MAX_PANES = 64

function paneIdList(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PANES) return null
  if (!raw.every((id): id is string => typeof id === 'string' && id !== '')) return null
  return new Set(raw).size === raw.length ? raw : null
}

export function checkPaneMove(
  deps: Omit<PaneMoveDeps, 'movePanes' | 'moveWorkspace'>,
  windowId: string,
  sourceId: unknown,
  targetId: unknown,
  rawPaneIds: unknown,
  whole: unknown,
): PaneMoveResult {
  const paneIds = paneIdList(rawPaneIds)
  if (
    !paneIds ||
    typeof whole !== 'boolean' ||
    typeof sourceId !== 'string' ||
    typeof targetId !== 'string' ||
    sourceId === targetId ||
    deps.ownerWindow(sourceId) !== windowId ||
    deps.ownerWindow(targetId) !== windowId
  ) {
    return { ok: false, error: 'not-owned' }
  }
  const panes = paneIds.map(deps.paneOf)
  if (panes.some((p) => p && (p.windowId !== windowId || p.workspaceId !== sourceId))) {
    return { ok: false, error: 'not-owned' }
  }
  if (panes.some((p) => p?.manager) || (whole && deps.hasManager(sourceId))) {
    return { ok: false, error: 'manager' }
  }
  if (deps.isScratch(sourceId) || deps.isScratch(targetId)) return { ok: false, error: 'scratch' }
  return crossesSandbox([sourceId], targetId, deps.isSandboxed)
    ? { ok: false, error: 'sandbox' }
    : { ok: true }
}

export function registerPaneMoveIpc(deps: PaneMoveDeps): void {
  ipcMain.handle(
    'workspace:move-panes',
    (e, sourceId: unknown, targetId: unknown, paneIds: unknown, whole: unknown): PaneMoveResult => {
      const result = checkPaneMove(deps, String(e.sender.id), sourceId, targetId, paneIds, whole)
      if (!result.ok) return result
      if (whole) deps.moveWorkspace(sourceId as string, targetId as string)
      else deps.movePanes(paneIds as string[], sourceId as string, targetId as string)
      return result
    },
  )
}
