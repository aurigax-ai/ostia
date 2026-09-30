import { ipcMain } from 'electron'
import type { WorkspaceSandbox } from '../../shared/sandbox'
import type { WorkspaceSandboxes } from './workspaceSandboxes'

export interface SandboxIpcDeps {
  sandboxes: WorkspaceSandboxes
  ownerWindow: (workspaceId: string) => string | undefined
}

export function ownsWorkspace(
  deps: Pick<SandboxIpcDeps, 'ownerWindow'>,
  senderId: number,
  workspaceId: unknown,
): workspaceId is string {
  return typeof workspaceId === 'string' && deps.ownerWindow(workspaceId) === String(senderId)
}

export function registerSandboxIpc(deps: SandboxIpcDeps): void {
  ipcMain.handle('sandbox:get', (e, workspaceId: unknown): WorkspaceSandbox | null =>
    ownsWorkspace(deps, e.sender.id, workspaceId) ? deps.sandboxes.settings(workspaceId) : null,
  )
  ipcMain.handle(
    'sandbox:set-enabled',
    (e, workspaceId: unknown, enabled: unknown): WorkspaceSandbox | null => {
      if (!ownsWorkspace(deps, e.sender.id, workspaceId) || typeof enabled !== 'boolean') {
        return null
      }
      return deps.sandboxes.update(workspaceId, (current) => ({ ...current, enabled }))
    },
  )
}
