import { ipcMain } from 'electron'
import { busLabel } from '../../shared/agents/busMessages'
import type { MailItem, MailMap } from '../../shared/agents/mailApi'
import { getByPaneId, resolveExternal } from '../control/idRegistry'
import { dismissFailed, mailViews, onBusChange } from './busStore'

export function mailMap(): MailMap {
  const map: MailMap = {}
  for (const view of mailViews()) {
    const to = resolveExternal(view.to)
    if (to?.kind !== 'pane') continue
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

export function registerMailIpc(broadcast: (channel: string, payload: unknown) => void): void {
  onBusChange(() => broadcast('bus:mail', mailMap()))
  ipcMain.handle('bus:mail-snapshot', () => mailMap())
  ipcMain.handle('bus:mail-dismiss', (_e, paneId: unknown) => {
    const identity = typeof paneId === 'string' ? getByPaneId(paneId) : undefined
    if (identity) dismissFailed(identity.externalId)
  })
}
