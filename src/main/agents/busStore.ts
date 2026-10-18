import { randomUUID } from 'node:crypto'
import type {
  BusMessageKind,
  BusMessagePhase,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { MAIL_PANE_CLOSED, mailExpired } from '../../shared/agents/agentIssues'
import {
  type MailKind,
  type MailPending,
  type MailState,
  type MailVia,
  busPreview,
} from '../../shared/agents/busMessages'
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
  lease?: string
  leasedUntil?: number
  via?: MailVia
  deliveredAt?: string
  failedAt?: string
  reason?: string
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

interface BusData {
  mail: Mail[]
  handoffs: Handoff[]
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
  kind?: MailKind
}

export const INBOX_MAX = 200
export const MAIL_TTL_MS = 24 * 60 * 60 * 1000
export const LEASE_MS = 120_000
export const HISTORY_MS = 7 * 24 * 60 * 60 * 1000
export const HISTORY_PER_SENDER = 500
const SENT_LISTED = 50
const OSTIA_SENDER = 'ostia'

let data: BusData | undefined
let observer: ((observation: BusObservation) => void) | undefined
let inflight: Promise<void> | undefined
let dirty = false

const settled = new Map<string, Set<() => void>>()
const waiters = new Map<string, Set<(mail: Mail[]) => void>>()

function busPath(): string {
  return storePath('bus', 'global')
}

function store(): BusData {
  if (!data) {
    const stored = loadJson<Partial<BusData>>(busPath(), {})
    data = { mail: stored.mail ?? [], handoffs: stored.handoffs ?? [] }
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

export function markBusDirty(): void {
  dirty = true
  inflight ??= drain()
}

export async function flushBus(): Promise<void> {
  while (inflight) await inflight
}

export async function resetBus(): Promise<void> {
  await flushBus()
  data = undefined
  settled.clear()
  waiters.clear()
}

export function setBusObserver(next: ((observation: BusObservation) => void) | undefined): void {
  observer = next
}

export function busHandoffs(): Handoff[] {
  return store().handoffs
}

function observe(mail: Mail, phase: BusMessagePhase): void {
  if (mail.quiet) return
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
  const listeners = settled.get(mail.id)
  if (!listeners) return
  settled.delete(mail.id)
  for (const listener of [...listeners]) listener()
}

function deliverMail(mail: Mail, via: MailVia, at: string): void {
  mail.via = via
  mail.deliveredAt = at
  settle(mail, 'delivered')
}

function failMail(mail: Mail, reason: string, at: string): void {
  mail.reason = reason
  mail.failedAt = at
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
  }
  store().mail.push(mail)
  observe(mail, 'queued')
  const parked = waiters.get(draft.to)
  if (parked && parked.size > 0) {
    waiters.delete(draft.to)
    const delivered = snapshot(mail)
    deliverMail(mail, 'read', mail.ts)
    for (const resolve of parked) resolve([delivered])
  }
  markBusDirty()
  return mail
}

export function setPending(id: string, pending: MailPending): void {
  const mail = store().mail.find((item) => item.id === id)
  if (!mail || mail.state !== 'queued' || mail.pending === pending) return
  mail.pending = pending
  markBusDirty()
}

export function getMail(id: string): Mail | undefined {
  sweepBus()
  const mail = store().mail.find((item) => item.id === id)
  return mail ? snapshot(mail) : undefined
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
    .mail.filter((mail) => mail.from === from && !mail.quiet)
    .slice(-SENT_LISTED)
    .map(snapshot)
}

export function takeMail(to: string, via: MailVia, pick: (mail: Mail) => boolean): Mail[] {
  sweepBus()
  const at = new Date().toISOString()
  const taken: Mail[] = []
  for (const mail of store().mail) {
    if (mail.to !== to || mail.state !== 'queued' || !pick(mail)) continue
    taken.push(snapshot(mail))
    deliverMail(mail, via, at)
  }
  if (taken.length > 0) markBusDirty()
  return taken
}

export function leaseMail(
  to: string,
  via: MailVia,
  pick: (mail: Mail) => boolean,
): { lease: string; messages: Mail[] } | undefined {
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

export function whenSettled(
  id: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Mail | undefined> {
  return new Promise((resolve) => {
    const current = store().mail.find((item) => item.id === id)
    if (!current || !undelivered(current)) return resolve(current && snapshot(current))
    const listeners = settled.get(id) ?? new Set()
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      listeners.delete(finish)
      const latest = store().mail.find((item) => item.id === id)
      resolve(latest && snapshot(latest))
    }
    const timer = setTimeout(finish, timeoutMs)
    signal.addEventListener('abort', finish, { once: true })
    listeners.add(finish)
    settled.set(id, listeners)
  })
}

export function addWaiter(to: string, resolve: (mail: Mail[]) => void): () => void {
  const parked = waiters.get(to) ?? new Set()
  parked.add(resolve)
  waiters.set(to, parked)
  return () => {
    parked.delete(resolve)
    if (parked.size === 0 && waiters.get(to) === parked) waiters.delete(to)
  }
}

export function postBusMessage(from: string, to: string, text: string): string {
  return enqueue({ from, to, text, quiet: true }).id
}

export function tellPane(to: string, text: string): string {
  return enqueue({ from: OSTIA_SENDER, to, text }).id
}
