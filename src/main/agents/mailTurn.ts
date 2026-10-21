import { busTurnContext } from '../../shared/agents/busMessages'
import { inboxOf, leaseMail } from './busStore'
import { mailers } from './mailers'
import { withSenderName } from './mailSender'

export type MailTurn =
  | { text: string; lease: string; ids: string[]; retryMs?: number }
  | { limited: true; retryMs: number }
  | { busy: true }
  | { retryMs: number }
  | Record<string, never>

export function takeMailTurn(me: string, agentBusy: boolean): MailTurn {
  if (!mailers.state(me)) mailers.set(me, false)
  if (mailers.limited(me)) return { limited: true, retryMs: mailers.limitedMs(me) }
  if (agentBusy) return { busy: true }
  const waitMs = mailers.eventsWaitMs(me)
  const queued = inboxOf(me).filter((mail) => mail.state === 'queued' && !mail.quiet)
  const due = queued.filter((mail) => mail.kind !== 'event' || waitMs === 0)
  const context = busTurnContext(
    due.map((mail) => ({ ...withSenderName(mail), text: mail.text ?? '' })),
  )
  const held = queued.length - due.length
  if (!context) return held > 0 ? { retryMs: waitMs } : {}
  const shown = new Set(context.shown)
  const leased = leaseMail(me, 'turn', (mail) => shown.has(mail.id))
  if (!leased) return {}
  if (leased.messages.some((mail) => mail.kind === 'event')) mailers.markEvents(me)
  mailers.recordTurn(me)
  return {
    text: context.text,
    lease: leased.lease,
    ids: context.shown,
    ...(held > 0 ? { retryMs: waitMs } : {}),
  }
}
