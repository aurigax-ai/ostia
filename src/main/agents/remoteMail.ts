import { BUS_SEND_TEXT_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type {
  RemoteMailRequest,
  RemoteMailResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteMail'
import type { MailPending } from '../../shared/agents/busMessages'
import {
  backNotice,
  isPaneId,
  offlineNotice,
  parseRemoteRef,
  remoteRef,
  remoteRoute,
} from '../../shared/remote/remoteRef'
import { ensureCaps } from '../approvals/controlElevation'
import {
  type ControlMethodContext,
  type ExtensionMethodContext,
  registerControlMethod,
} from '../control/controlServer'
import { type PaneIdentity, resolveExternal } from '../control/idRegistry'
import {
  enqueue,
  failedOnRoute,
  getMail,
  hasMailed,
  type Mail,
  peersOfRoute,
  postEvent,
  queuedOnRoute,
  receive,
  refusedOnRoute,
  setPending,
  storedOnRoute,
} from './busStore'

const SYSTEM_SENDER = 'ostia'

interface Link {
  online: boolean
  since: string
  noticed: Set<string>
}

const links = new Map<string, Link>()

function notify(peers: Iterable<string>, text: string): void {
  for (const peer of peers) {
    if (resolveExternal(peer)?.kind === 'pane') postEvent(SYSTEM_SENDER, peer, text)
  }
}

export async function sendToRemote(
  ctx: ControlMethodContext,
  ref: string,
  text: string,
): Promise<Mail> {
  await ensureCaps(ctx.authed, ctx.identity, ['all-workspaces'], 'bus.send', `to ${ref}`)
  const target = parseRemoteRef(ref)
  const host = target?.host ?? ''
  const from = ctx.identity.externalId
  const mail = enqueue({ from, to: ref, text, route: remoteRoute(host) })
  const link = links.get(host)
  if (link?.online) return mail
  setPending(mail.id, 'remote-offline' satisfies MailPending)
  if (!link) links.set(host, { online: false, since: new Date().toISOString(), noticed: new Set() })
  const outage = links.get(host)
  if (outage && !outage.noticed.has(from)) {
    outage.noticed.add(from)
    const waiting = queuedOnRoute(remoteRoute(host)).length
    notify([from], offlineNotice(host, outage.since.slice(11, 16), waiting))
  }
  return getMail(mail.id) ?? mail
}

function linkChanged(host: string, online: boolean, delivered: number): RemoteMailResult {
  const route = remoteRoute(host)
  const before = links.get(host)
  if (online) {
    const since = before?.since ?? new Date().toISOString()
    links.set(host, { online: true, since, noticed: new Set() })
    if (!before || before.online) return { ok: true }
    const expired = failedOnRoute(route, before.since)
    notify(
      new Set([...peersOfRoute(route), ...before.noticed]),
      backNotice(host, delivered, expired),
    )
    return { ok: true, expired }
  }
  if (before && !before.online) return { ok: true }
  const since = new Date().toISOString()
  links.set(host, { online: false, since, noticed: new Set() })
  if (before) {
    notify(
      peersOfRoute(route),
      offlineNotice(host, since.slice(11, 16), queuedOnRoute(route).length),
    )
  }
  return { ok: true }
}

async function receiveFromRemote(
  request: Extract<RemoteMailRequest, { op: 'in' }>,
  pending: (pane: PaneIdentity) => Promise<MailPending>,
): Promise<RemoteMailResult> {
  const { host, mail } = request
  const refused = (error: string): RemoteMailResult => ({ ok: false, error })
  if (!parseRemoteRef(remoteRef(host, mail.pane)) || !isPaneId(mail.pane))
    return refused('bad-from')
  if (typeof mail.id !== 'string' || mail.id.length === 0 || mail.id.length > 80) {
    return refused('bad-id')
  }
  if (
    typeof mail.text !== 'string' ||
    mail.text.length === 0 ||
    mail.text.length > BUS_SEND_TEXT_MAX
  ) {
    return refused('bad-text')
  }
  const target = resolveExternal(mail.to)
  if (target?.kind !== 'pane') return refused('unknown-pane')
  const from = remoteRef(host, mail.pane)
  if (!hasMailed(target.externalId, from)) return refused('not-allowed')
  const stored = await receive({
    id: `${host}:${mail.id}`,
    origin: remoteRoute(host),
    from,
    to: target.externalId,
    text: mail.text,
  }).catch(() => null)
  if (stored === null) return refused('write-failed')
  if (stored === 'full') return refused('full')
  const queued = getMail(`${host}:${mail.id}`)
  if (queued?.state === 'queued') setPending(queued.id, await pending(target))
  return { ok: true }
}

export function registerRemoteMail(deps: {
  fromSsh: (ctx: ExtensionMethodContext) => boolean
  pending: (pane: PaneIdentity) => Promise<MailPending>
}): void {
  registerControlMethod('ext.remoteMail', {
    callers: 'extensions',
    handler: async (params, ctx: ExtensionMethodContext): Promise<RemoteMailResult> =>
      deps.fromSsh(ctx)
        ? handleRemoteMail((params ?? {}) as RemoteMailRequest, deps.pending)
        : { ok: false, error: 'ssh-only' },
  })
}

function senderStays(route: string, mail: Mail): boolean {
  if (resolveExternal(mail.from)?.kind === 'pane') return true
  refusedOnRoute(route, mail.id, 'sender-closed')
  return false
}

export async function handleRemoteMail(
  request: RemoteMailRequest,
  pending: (pane: PaneIdentity) => Promise<MailPending>,
): Promise<RemoteMailResult> {
  const host = typeof request.host === 'string' ? request.host : ''
  if (!parseRemoteRef(remoteRef(host, '00000000'))) return { ok: false, error: 'bad-host' }
  const route = remoteRoute(host)
  const unknown: RemoteMailResult = { ok: false, error: 'unknown-mail' }
  switch (request.op) {
    case 'out':
      return {
        ok: true,
        out: queuedOnRoute(route)
          .filter((mail) => senderStays(route, mail))
          .map((mail) => ({
            id: mail.id,
            from: mail.from,
            to: mail.to,
            text: mail.text ?? '',
            ts: mail.ts,
          })),
      }
    case 'stored':
      return typeof request.id === 'string' && storedOnRoute(route, request.id)
        ? { ok: true }
        : unknown
    case 'refused':
      return typeof request.id === 'string' &&
        typeof request.reason === 'string' &&
        refusedOnRoute(route, request.id, request.reason.slice(0, 64))
        ? { ok: true }
        : unknown
    case 'in':
      return receiveFromRemote(request, pending)
    case 'link':
      return linkChanged(host, request.online === true, request.delivered ?? 0)
    default:
      return { ok: false, error: 'bad-op' }
  }
}
