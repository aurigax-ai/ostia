import { MAIL_WAKES_MAX, MAIL_WAKES_WINDOW_MS } from '../../shared/agents/mailDelivery'
import { type PaneIdentity, resolveExternal } from '../control/idRegistry'
import type { PaneEntry } from '../panes/paneList'
import { claimWake, type Mail } from './busStore'

export interface MailWakeDeps {
  panes: () => Promise<PaneEntry[]>
  wake: (to: PaneIdentity) => Promise<{ woke: boolean; conflict?: string }>
  waking: { start: (paneId: string) => void; abandon: (paneId: string) => void }
  isSandboxed: (workspaceId: string) => boolean
  isScratch: (workspaceId: string) => boolean
  now: () => number
}

export function createMailWaker(deps: MailWakeDeps): (mail: Mail) => void {
  const run = async (mail: Mail): Promise<void> => {
    if (!mail.wakes) return
    const to = resolveExternal(mail.to)
    if (to?.kind !== 'pane' || to.manager) return
    if (deps.isSandboxed(to.workspaceId) || deps.isScratch(to.workspaceId)) return
    const entry = (await deps.panes()).find((pane) => pane.paneId === to.externalId)
    if (!entry?.hibernated || entry.waking) return
    if (!claimWake(to.externalId, deps.now(), MAIL_WAKES_MAX, MAIL_WAKES_WINDOW_MS)) return
    deps.waking.start(to.paneId)
    const woke = await deps.wake(to).catch(() => ({ woke: false }))
    if (!woke.woke) deps.waking.abandon(to.paneId)
  }

  return (mail) => {
    void run(mail).catch(() => undefined)
  }
}
