import { resolveExternal } from '../control/idRegistry'
import { nameOf } from '../panes/paneNames'

export function withSenderName<T extends { from: string }>(mail: T): T & { fromName?: string } {
  const sender = resolveExternal(mail.from)
  const held = sender?.kind === 'pane' ? nameOf(sender.paneId) : undefined
  return held ? { ...mail, fromName: held.name } : mail
}
