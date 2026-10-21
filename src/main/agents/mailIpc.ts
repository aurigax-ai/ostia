import { ipcMain } from 'electron'
import { busLabel } from '../../shared/agents/busMessages'
import type { MailItem, MailMap } from '../../shared/agents/mailApi'
import { getByPaneId, type PaneIdentity, resolveExternal } from '../control/idRegistry'
import { dismissFailed, mailViews, onBusChange } from './busStore'

export function mailMap(owns: (pane: PaneIdentity) => boolean = () => true): MailMap {
  const map: MailMap = {}
  for (const view of mailViews()) {
    const to = resolveExternal(view.to)
    if (to?.kind !== 'pane' || !owns(to)) continue
    const sender = resolveExternal(view.from)
    const from: MailItem['from'] =
      sender?.kind === 'pane' ? { paneId: sender.paneId } : { label: busLabel(view.from) }
    const { id, state, ts, pending, reason } = view
    const item: MailItem = {
      id,
      state,
      from,
      ts,
      ...(pending ? { pending } : {}),
      ...(reason ? { reason } : {}),
    }
    map[to.paneId] = [...(map[to.paneId] ?? []), item]
  }
  return map
}

export interface MailIpcDeps {
  windowIds: () => string[]
  sendToWindow: (windowId: string, channel: string, payload: unknown) => void
  workspaceWindowId: (workspaceId: string) => string | undefined
}

export function registerMailIpc(deps: MailIpcDeps): void {
  const ownedBy =
    (windowId: string) =>
    (pane: PaneIdentity): boolean =>
      (deps.workspaceWindowId(pane.workspaceId) ?? pane.windowId) === windowId
  onBusChange(() => {
    for (const windowId of deps.windowIds()) {
      deps.sendToWindow(windowId, 'bus:mail', mailMap(ownedBy(windowId)))
    }
  })
  ipcMain.handle('bus:mail-snapshot', (e) => mailMap(ownedBy(String(e.sender.id))))
  ipcMain.handle('bus:mail-dismiss', (e, paneId: unknown) => {
    const identity = typeof paneId === 'string' ? getByPaneId(paneId) : undefined
    if (identity && ownedBy(String(e.sender.id))(identity)) dismissFailed(identity.externalId)
  })
}
