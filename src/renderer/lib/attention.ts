import type { AttentionState, SessionLiveState } from '@shared/types'

export type { AttentionState }

export interface PaneAttention {
  state: AttentionState
  unread: boolean
  message?: string
  at: number
}

export type AttentionEvent =
  | { type: 'set'; state: AttentionState; message?: string; at: number }
  | { type: 'notify'; message: string; waiting: boolean; at: number }
  | { type: 'bell'; at: number }
  | { type: 'commandStart'; at: number }
  | { type: 'commandEnd'; exitCode: number; long: boolean; message?: string; at: number }
  | { type: 'input'; at: number }
  | { type: 'view'; at: number }

export const EMPTY_ATTENTION: PaneAttention = { state: 'none', unread: false, at: 0 }

const LOUD: ReadonlySet<AttentionState> = new Set(['waiting', 'done', 'error'])

export function reduceAttention(prev: PaneAttention, event: AttentionEvent): PaneAttention {
  switch (event.type) {
    case 'set':
      if (event.state === 'none') return { state: 'none', unread: false, at: event.at }
      return {
        state: event.state,
        unread: LOUD.has(event.state) ? true : prev.unread,
        message: event.message ?? (event.state === prev.state ? prev.message : undefined),
        at: event.at,
      }
    case 'notify':
      return {
        state: event.waiting ? 'waiting' : prev.state,
        unread: true,
        message: event.message,
        at: event.at,
      }
    case 'bell':
      return { ...prev, unread: true, at: event.at }
    case 'commandStart':
      return prev.state === 'none' ? prev : { ...prev, state: 'none' }
    case 'commandEnd':
      if (event.exitCode !== 0) {
        return { state: 'error', unread: true, message: event.message, at: event.at }
      }
      if (event.long) return { state: 'done', unread: true, message: event.message, at: event.at }
      return prev
    case 'input':
      return prev.state === 'waiting' ? { ...prev, state: 'none' } : prev
    case 'view':
      if (!prev.unread && prev.state !== 'done') return prev
      return { ...prev, unread: false, state: prev.state === 'done' ? 'none' : prev.state }
  }
}

export function needsRing(a: PaneAttention | undefined): boolean {
  return !!a?.unread && (a.state === 'waiting' || a.state === 'error')
}

export function paneLiveState(a: PaneAttention | undefined, running: boolean): SessionLiveState {
  if (a && a.state !== 'none') return a.state
  return running ? 'working' : 'idle'
}

const RANK: Record<SessionLiveState, number> = {
  idle: 0,
  working: 1,
  done: 2,
  error: 3,
  waiting: 4,
}

export function aggregateSessionState(panes: readonly SessionLiveState[]): SessionLiveState {
  let best: SessionLiveState = 'idle'
  for (const s of panes) if (RANK[s] > RANK[best]) best = s
  return best
}

export function unreadCount(
  byPane: Readonly<Record<string, PaneAttention>>,
  paneIds: Iterable<string>,
): number {
  let n = 0
  for (const id of paneIds) if (byPane[id]?.unread) n += 1
  return n
}

export function latestUnread(
  byPane: Readonly<Record<string, PaneAttention>>,
  paneIds: Iterable<string>,
): string | null {
  let best: string | null = null
  let bestAt = -1
  for (const id of paneIds) {
    const a = byPane[id]
    if (a?.unread && a.at > bestAt) {
      best = id
      bestAt = a.at
    }
  }
  return best
}

export function latestWaitingAt(
  byPane: Readonly<Record<string, PaneAttention>>,
  paneIds: Iterable<string>,
): number {
  let at = 0
  for (const id of paneIds) {
    const a = byPane[id]
    if (a?.state === 'waiting' && a.at > at) at = a.at
  }
  return at
}

export interface OscNotification {
  title: string
  body?: string
}

const CONEMU_SUBCOMMAND = /^(?:[1-9]|1[0-2])(?:;|$)/

export function parseOsc9(data: string): OscNotification | null {
  if (CONEMU_SUBCOMMAND.test(data)) return null
  const title = data.trim()
  return title ? { title } : null
}

export function parseOsc777(data: string): OscNotification | null {
  const [kind, title, ...rest] = data.split(';')
  if (kind !== 'notify') return null
  const body = rest.join(';').trim()
  const t = (title ?? '').trim()
  if (!t && !body) return null
  return body ? { title: t || body, body: t ? body : undefined } : { title: t }
}

export interface KittyChunk {
  id: string
  done: boolean
  part: 'title' | 'body'
  text: string
}

export function parseOsc99(data: string, decode: (b64: string) => string): KittyChunk | null {
  const sep = data.indexOf(';')
  if (sep < 0) return null
  const meta = new Map<string, string>()
  for (const pair of data.slice(0, sep).split(':')) {
    const eq = pair.indexOf('=')
    if (eq > 0) meta.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
  const part = meta.get('p') ?? 'title'
  if (part !== 'title' && part !== 'body') return null
  const raw = data.slice(sep + 1)
  let text = raw
  if (meta.get('e') === '1') {
    try {
      text = decode(raw)
    } catch {
      return null
    }
  }
  return { id: meta.get('i') ?? '0', done: meta.get('d') !== '0', part, text }
}

export class KittyNotificationAssembler {
  private pending = new Map<string, { title: string; body: string }>()

  push(chunk: KittyChunk): OscNotification | null {
    const acc = this.pending.get(chunk.id) ?? { title: '', body: '' }
    acc[chunk.part] += chunk.text
    if (!chunk.done) {
      this.pending.set(chunk.id, acc)
      return null
    }
    this.pending.delete(chunk.id)
    const title = acc.title.trim()
    const body = acc.body.trim()
    if (!title && !body) return null
    return body ? { title: title || body, body: title ? body : undefined } : { title }
  }
}

export function notificationMessage(n: OscNotification): string {
  return n.body ? `${n.title}: ${n.body}` : n.title
}
