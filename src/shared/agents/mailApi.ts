import type { MailPending } from './busMessages'

export interface MailItem {
  id: string
  state: 'queued' | 'failed'
  from: { paneId?: string; label?: string }
  ts: string
  pending?: MailPending
  reason?: string
}

export type MailMap = Record<string, MailItem[]>

export interface MailApi {
  snapshot: () => Promise<MailMap>
  onChange: (cb: (map: MailMap) => void) => () => void
  dismiss: (paneId: string) => Promise<void>
}
