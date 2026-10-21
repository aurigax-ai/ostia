import { registerControlMethod } from '../control/controlServer'
import { getByPaneId, type PaneIdentity, resolveExternal } from '../control/idRegistry'
import type { PaneJournal } from '../panes/paneJournal'
import type { PaneEntry } from '../panes/paneList'
import { onBusChange, onMailQueued } from './busStore'
import { CodexMail } from './codexMail'
import { connectCodexRpc } from './codexRpc'
import { codexSocketOf } from './codexSockets'

export interface CodexMailWiringDeps {
  journal: PaneJournal
  panes: () => Promise<PaneEntry[]>
  version: string
}

export function registerCodexMail({ journal, panes, version }: CodexMailWiringDeps): CodexMail {
  const mail = new CodexMail({
    socketOf: codexSocketOf,
    connect: (socket) => connectCodexRpc(socket, version),
    threadOf: async (externalId) => {
      const entry = (await panes()).find((pane) => pane.paneId === externalId)
      return entry?.agent === 'codex' ? entry.agentSessionId : undefined
    },
    agentBusy: (externalId) => {
      const pane = resolveExternal(externalId)
      const state = pane?.kind === 'pane' ? journal.stateOf(pane.paneId) : undefined
      return state === 'working' || state === 'waiting'
    },
    schedule: (ms, fn) => void setTimeout(fn, ms).unref(),
    now: Date.now,
  })
  const kickAll = (): void => {
    for (const externalId of mail.attachedIds()) mail.kick(externalId)
  }
  onBusChange(kickAll)
  onMailQueued((queued) => mail.kick(queued.to))
  journal.subscribe((paneId, event) => {
    const pane: PaneIdentity | undefined = getByPaneId(paneId)
    if (pane && event.kind === 'state') mail.kick(pane.externalId)
  })
  registerControlMethod('codex.attach', {
    handler: (_params, ctx) => {
      mail.attach(ctx.identity.externalId)
      return { ok: true }
    },
  })
  registerControlMethod('codex.detach', {
    handler: (_params, ctx) => {
      mail.detach(ctx.identity.externalId)
      return { ok: true }
    },
  })
  return mail
}
