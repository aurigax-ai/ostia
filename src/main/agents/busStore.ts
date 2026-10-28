import { randomUUID } from 'node:crypto'
import type {
  BusMessageKind,
  BusMessagePhase,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { MAIL_PANE_CLOSED, mailExpired } from '../../shared/agents/agentIssues'
import {
  busPreview,
  type MailKind,
  type MailPending,
  type MailState,
  type MailVia,
} from '../../shared/agents/busMessages'
import type { AgentJournal } from '../diagnostics/agentJournal'
import { loadJson, saveJsonAsync, storePath } from '../platform/jsonStore'

export interface Mail {
  id: string
  kind: MailKind
  from: string
  to: string
  text?: string
  preview: string
  ts: string
  state: MailState
  pending?: MailPending
  task?: true
  quiet?: true
  wakes?: true
  lease?: string
  leasedUntil?: number
  via?: MailVia
  deliveredAt?: string
  failedAt?: string
  reason?: string
  dismissed?: true
}

export type HandoffState = 'submitted' | 'claimed' | 'completed' | 'failed'

export interface HandoffContext {
  artifacts?: string[]
  workDir?: string
}

export interface Handoff {
  id: string
  from: string
  to: string
  task: string
  summary: string
  state: HandoffState
  context?: HandoffContext
  ts: string
  updatedAt: string
}

export interface Watch {
  subscriber: string
  watched: string
  until: string[]
}

interface BusData {
  mail: Mail[]
  handoffs: Handoff[]
  watches: Watch[]
  wakes: Record<string, number[]>
}

export interface BusObservation {
  id: string
  from: string
  to: string
  kind: BusMessageKind
  phase: BusMessagePhase
}

export interface MailDraft {
  from: string
  to: string
  text: string
  task?: true
  quiet?: true
  wakes?: true
  kind?: MailKind
}

export const INBOX_MAX = 200
export const MAIL_TTL_MS = 24 * 60 * 60 * 1000
export const LEASE_MS = 120_000
export const HISTORY_MS = 7 * 24 * 60 * 60 * 1000
export const HISTORY_PER_SENDER = 500
const SENT_LISTED = 50
const EVENT_LINES_MAX = 20
const OSTIA_SENDER = 'ostia'

let data: BusData | undefined
let observer: ((observation: BusObservation) => void) | undefined
let journal: Pick<AgentJournal, 'mail' | 'leaseTimeout'> | undefined
let inflight: Promise<void> | undefined
let dirty = false

export interface HandedMail {
  lease: string
  messages: Mail[]
}

interface Waiter {
  resolve: (handed: HandedMail) => void
  pick: (mail: Mail) => boolean
  priority: boolean
}

const waiters = new Map<string, Set<Waiter>>()

function busPath(): string {
  return storePath('bus', 'global')
}

function store(): BusData {
  if (!data) {
    const stored = loadJson<Partial<BusData>>(busPath(), {})
    data = {
      mail: stored.mail ?? [],
      handoffs: stored.handoffs ?? [],
      watches: stored.watches ?? [],
      wakes: stored.wakes ?? {},
    }
  }
  return data
}

async function drain(): Promise<void> {
  while (dirty) {
    dirty = false
    await saveJsonAsync(busPath(), store(), { secure: true }).catch(() => {})
  }
  inflight = undefined
}

const changeListeners = new Set<() => void>()
const queuedListeners = new Set<(mail: Mail) => void>()
let changeQueued = false

export function onBusChange(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

export function onMailQueued(listener: (mail: Mail) => void): void {
  queuedListeners.add(listener)
}

function announceQueued(mail: Mail): void {
  if (mail.quiet || mail.state !== 'queued') return
  for (const listener of [...queuedListeners]) listener(snapshot(mail))
}

export function markBusDirty(): void {
  dirty = true
  inflight ??= drain()
  if (changeQueued) return
  changeQueued = true
  queueMicrotask(() => {
    changeQueued = false
    for (const listener of [...changeListeners]) listener()
  })
}

export async function flushBus(): Promise<void> {
  while (inflight) await inflight
}

export async function resetBus(): Promise<void> {
  await flushBus()
  data = undefined
  waiters.clear()
}

export function setBusObserver(next: ((observation: BusObservation) => void) | undefined): void {
  observer = next
}

export function setBusJournal(next: Pick<AgentJournal, 'mail' | 'leaseTimeout'> | undefined): void {
  journal = next
}

export function busHandoffs(): Handoff[] {
  return store().handoffs
}

function observe(mail: Mail, phase: BusMessagePhase): void {
  if (mail.quiet || mail.kind === 'event') return
  observer?.({
    id: mail.id,
    from: mail.from,
    to: mail.to,
    kind: mail.task ? 'task' : 'message',
    phase,
  })
}

function undelivered(mail: Mail): boolean {
  return mail.state === 'queued' || mail.state === 'leased'
}

function settle(mail: Mail, state: 'delivered' | 'failed'): void {
  mail.state = state
  mail.text = undefined
  mail.lease = undefined
  mail.leasedUntil = undefined
  observe(mail, state)
}

function deliverMail(mail: Mail, via: MailVia, at: string): void {
  mail.via = via
  mail.deliveredAt = at
  settle(mail, 'delivered')
}

function failMail(mail: Mail, reason: string, at: string): void {
  mail.reason = reason
  mail.failedAt = at
  journal?.mail(reason, Date.parse(at) - Date.parse(mail.ts))
  settle(mail, 'failed')
}

function snapshot(mail: Mail): Mail {
  return { ...mail }
}

function pruneHistory(now: number): boolean {
  const { mail } = store()
  const keep = new Map<string, number>()
  const kept: Mail[] = []
  let changed = false
  for (let i = mail.length - 1; i >= 0; i--) {
    const item = mail[i]
    if (!undelivered(item)) {
      const at = Date.parse(item.deliveredAt ?? item.failedAt ?? item.ts)
      const count = (keep.get(item.from) ?? 0) + 1
      keep.set(item.from, count)
      if (now - at > HISTORY_MS || count > HISTORY_PER_SENDER) {
        changed = true
        continue
      }
    }
    kept.push(item)
  }
  if (changed) store().mail = kept.reverse()
  return changed
}

export function sweepBus(now = Date.now()): void {
  let changed = false
  const at = new Date(now).toISOString()
  for (const mail of store().mail) {
    if (mail.state === 'leased' && (mail.leasedUntil ?? 0) <= now) {
      journal?.leaseTimeout(now - Date.parse(mail.ts))
      mail.state = 'queued'
      mail.lease = undefined
      mail.leasedUntil = undefined
      changed = true
    }
    if (mail.state === 'queued' && Date.parse(mail.ts) + MAIL_TTL_MS <= now) {
      failMail(mail, mailExpired(mail.pending ?? 'queued'), at)
      changed = true
    }
  }
  if (pruneHistory(now) || changed) markBusDirty()
}

export function inboxFull(to: string): boolean {
  sweepBus()
  return store().mail.filter((mail) => mail.to === to && undelivered(mail)).length >= INBOX_MAX
}

export function enqueue(draft: MailDraft): Mail {
  sweepBus()
  const mail: Mail = {
    id: randomUUID(),
    kind: draft.kind ?? 'message',
    from: draft.from,
    to: draft.to,
    text: draft.text,
    preview: busPreview(draft.text),
    ts: new Date().toISOString(),
    state: 'queued',
    ...(draft.task ? { task: true as const } : {}),
    ...(draft.quiet ? { quiet: true as const } : {}),
    ...(draft.wakes ? { wakes: true as const } : {}),
  }
  store().mail.push(mail)
  observe(mail, 'queued')
  const parked = waiters.get(draft.to)
  const matching = parked ? [...parked].filter((waiter) => waiter.pick(mail)) : []
  const first = matching.find((waiter) => waiter.priority) ?? matching[0]
  if (parked && first) {
    parked.delete(first)
    if (parked.size === 0) waiters.delete(draft.to)
    const handed = leaseMail(draft.to, 'read', (item) => item.id === mail.id)
    if (handed) first.resolve(handed)
  }
  markBusDirty()
  announceQueued(mail)
  return mail
}

export function claimWake(externalId: string, now: number, max: number, windowMs: number): boolean {
  const { wakes } = store()
  for (const [id, times] of Object.entries(wakes)) {
    const recent = times.filter((at) => at > now - windowMs)
    if (recent.length === 0) delete wakes[id]
    else wakes[id] = recent
  }
  const recent = wakes[externalId] ?? []
  if (recent.length >= max) return false
  wakes[externalId] = [...recent, now]
  markBusDirty()
  return true
}

export function postEvent(from: string, to: string, text: string): void {
  const open = store().mail.find(
    (mail) =>
      mail.kind === 'event' && mail.state === 'queued' && mail.from === from && mail.to === to,
  )
  if (!open) {
    enqueue({ from, to, text, kind: 'event' })
    return
  }
  open.text = [...(open.text ?? '').split('\n'), text].slice(-EVENT_LINES_MAX).join('\n')
  open.preview = busPreview(text)
  open.ts = new Date().toISOString()
  markBusDirty()
}

export function watchPane(subscriber: string, watched: string, until: string[]): void {
  const { watches } = store()
  const known = watches.find((w) => w.subscriber === subscriber && w.watched === watched)
  if (known) known.until = until
  else watches.push({ subscriber, watched, until })
  markBusDirty()
}

export function unwatchPanes(subscriber: string, watched?: string[]): void {
  const before = store().watches.length
  store().watches = store().watches.filter(
    (w) => w.subscriber !== subscriber || (watched !== undefined && !watched.includes(w.watched)),
  )
  if (store().watches.length !== before) markBusDirty()
}

export function watchesOf(subscriber: string): Watch[] {
  return store()
    .watches.filter((w) => w.subscriber === subscriber)
    .map((w) => ({ ...w, until: [...w.until] }))
}

export function watchersOf(watched: string): Watch[] {
  return store()
    .watches.filter((w) => w.watched === watched)
    .map((w) => ({ ...w, until: [...w.until] }))
}

export function dropWatchesOf(externalId: string): void {
  const before = store().watches.length
  store().watches = store().watches.filter(
    (w) => w.subscriber !== externalId && w.watched !== externalId,
  )
  if (store().watches.length !== before) markBusDirty()
}

export function setPending(id: string, pending: MailPending): void {
  const mail = store().mail.find((item) => item.id === id)
  if (mail?.state !== 'queued' || mail.pending === pending) return
  mail.pending = pending
  markBusDirty()
}

export function getMail(id: string): Mail | undefined {
  sweepBus()
  const mail = store().mail.find((item) => item.id === id)
  return mail ? snapshot(mail) : undefined
}

export function queuedCounts(): Map<string, number> {
  sweepBus()
  const counts = new Map<string, number>()
  for (const mail of store().mail) {
    if (mail.state === 'queued' && !mail.quiet) counts.set(mail.to, (counts.get(mail.to) ?? 0) + 1)
  }
  return counts
}

export function inboxOf(to: string): Mail[] {
  sweepBus()
  return store()
    .mail.filter((mail) => mail.to === to && undelivered(mail))
    .map(snapshot)
}

export function sentBy(from: string): Mail[] {
  sweepBus()
  return store()
    .mail.filter((mail) => mail.from === from && !mail.quiet && mail.kind !== 'event')
    .slice(-SENT_LISTED)
    .map(snapshot)
}

export function mailCounts(pane: string) {
  sweepBus()
  const counts = { queued: 0, failed: 0, sentQueued: 0, sentFailed: 0 }
  let oldestQueuedMs: number | undefined
  let lastFailure: string | undefined
  const now = Date.now()
  for (const mail of store().mail) {
    if (mail.quiet) continue
    if (mail.to === pane) {
      if (undelivered(mail)) {
        counts.queued += 1
        oldestQueuedMs = Math.max(oldestQueuedMs ?? 0, now - Date.parse(mail.ts))
      } else if (mail.state === 'failed') {
        counts.failed += 1
        lastFailure = mail.reason
      }
    }
    if (mail.from === pane && mail.kind !== 'event') {
      if (undelivered(mail)) counts.sentQueued += 1
      else if (mail.state === 'failed') counts.sentFailed += 1
    }
  }
  return { ...counts, oldestQueuedMs, lastFailure }
}

export interface MailView {
  id: string
  state: 'queued' | 'failed'
  from: string
  to: string
  ts: string
  pending?: MailPending
  reason?: string
}

const FAILED_SHOWN_MAX = 5

export function mailViews(): MailView[] {
  sweepBus()
  const failedPerPane = new Map<string, number>()
  const views: MailView[] = []
  const mail = store().mail
  for (let i = mail.length - 1; i >= 0; i--) {
    const item = mail[i]
    if (item.quiet) continue
    const view = { id: item.id, from: item.from, to: item.to, ts: item.ts }
    if (undelivered(item)) {
      views.push({ ...view, state: 'queued', ...(item.pending ? { pending: item.pending } : {}) })
    } else if (item.state === 'failed' && !item.dismissed) {
      const shown = failedPerPane.get(item.to) ?? 0
      if (shown >= FAILED_SHOWN_MAX) continue
      failedPerPane.set(item.to, shown + 1)
      views.push({ ...view, state: 'failed', ...(item.reason ? { reason: item.reason } : {}) })
    }
  }
  return views.reverse()
}

export function dismissFailed(to: string): void {
  let changed = false
  for (const item of store().mail) {
    if (item.to === to && item.state === 'failed' && !item.dismissed) {
      item.dismissed = true
      changed = true
    }
  }
  if (changed) markBusDirty()
}

export function leaseMail(
  to: string,
  via: MailVia,
  pick: (mail: Mail) => boolean,
): HandedMail | undefined {
  sweepBus()
  const lease = randomUUID()
  const until = Date.now() + LEASE_MS
  const messages: Mail[] = []
  for (const mail of store().mail) {
    if (mail.to !== to || mail.state !== 'queued' || !pick(mail)) continue
    mail.state = 'leased'
    mail.lease = lease
    mail.leasedUntil = until
    mail.via = via
    messages.push(snapshot(mail))
  }
  if (messages.length === 0) return undefined
  markBusDirty()
  return { lease, messages }
}

export function ackMail(to: string, lease: string): string[] {
  sweepBus()
  const at = new Date().toISOString()
  const acked: string[] = []
  for (const mail of store().mail) {
    if (mail.to !== to || mail.state !== 'leased' || mail.lease !== lease) continue
    deliverMail(mail, mail.via ?? 'prompt', at)
    acked.push(mail.id)
  }
  if (acked.length > 0) markBusDirty()
  return acked
}

export function releaseMail(to: string, lease: string): void {
  let changed = false
  for (const mail of store().mail) {
    if (mail.to !== to || mail.state !== 'leased' || mail.lease !== lease) continue
    mail.state = 'queued'
    mail.lease = undefined
    mail.leasedUntil = undefined
    changed = true
  }
  if (changed) markBusDirty()
}

export function failLeased(to: string, lease: string, reason: string): void {
  const at = new Date().toISOString()
  let changed = false
  for (const mail of store().mail) {
    if (mail.to !== to || mail.state !== 'leased' || mail.lease !== lease) continue
    failMail(mail, reason, at)
    changed = true
  }
  if (changed) markBusDirty()
}

export function failPaneMail(to: string): void {
  const at = new Date().toISOString()
  let changed = false
  for (const mail of store().mail) {
    if (mail.to !== to || !undelivered(mail)) continue
    failMail(mail, MAIL_PANE_CLOSED, at)
    changed = true
  }
  if (changed) markBusDirty()
}

export function sentAfter(id: string, ts: string): (mail: Mail) => boolean {
  return (mail) => {
    const list = store().mail
    const at = list.findIndex((item) => item.id === id)
    return at === -1 ? mail.ts >= ts : list.indexOf(mail) > at
  }
}

export function addWaiter(
  to: string,
  resolve: (handed: HandedMail) => void,
  pick?: (mail: Mail) => boolean,
): () => void {
  const parked = waiters.get(to) ?? new Set()
  const waiter: Waiter = { resolve, pick: pick ?? (() => true), priority: pick !== undefined }
  parked.add(waiter)
  waiters.set(to, parked)
  return () => {
    parked.delete(waiter)
    if (parked.size === 0 && waiters.get(to) === parked) waiters.delete(to)
  }
}

export function postBusMessage(from: string, to: string, text: string): string {
  return enqueue({ from, to, text, quiet: true }).id
}

export function tellPane(to: string, text: string): string {
  return enqueue({ from: OSTIA_SENDER, to, text }).id
}
