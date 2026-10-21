import { randomBytes } from 'node:crypto'
import { read } from 'node:fs'
import {
  BROWSE_LIST_METHOD,
  BROWSE_LISTING_BYTES,
  BROWSE_NAME_BYTES,
  BROWSE_PAGE_ENTRIES,
  BROWSE_READ_MAX,
  BROWSE_READ_METHOD,
  type BrowseCallError,
  type BrowseChunkParams,
  type BrowseEntriesParams,
  type BrowseFlowResult,
  type BrowseLimits,
  type BrowseListParams,
  type BrowseListResult,
  type BrowseReadAtParams,
  type BrowseReadAtResult,
  type BrowseReadParams,
  type BrowseReadResult,
  browseCallBudget,
  browseReadBudget,
} from '@aurigax-ai/ostia-extension-sdk/contract/fileBrowse'
import {
  type BrowseCandidate,
  browseKindFor,
} from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { CancellationTokenSource, type MessageConnection } from 'vscode-jsonrpc/node'
import type { PaneIdentity } from '../control/idRegistry'
import type { EntryRead } from '../files/archives/archiveFile'
import type { RawEntry } from '../files/archives/archiveTree'
import type {
  BrowseProviders,
  BrowseTarget,
  ProviderListing,
} from '../files/archives/browseProviders'

const BROWSE_KILL_GRACE_MS = 5_000
const LIST_GRACE_MS = 5_000
const READ_DEADLINE_MS = 30_000
const MAX_IN_FLIGHT = 4
const MAX_QUEUED = 16
const READS_AT_ONCE = 2

export interface ExtensionBrowseHost {
  candidates(): BrowseCandidate[]
  connected(extId: string): Promise<MessageConnection>
  process(extId: string): unknown
  recycle(extId: string): void
}

export interface ExtensionBrowseTiming {
  listGraceMs: number
  readMs: number
  killGraceMs: number
}

interface Listing {
  entries: RawEntry[]
  bytes: number
  limits: BrowseLimits
  failed: boolean
  cut: boolean
}

interface Chunks {
  parts: Buffer[]
  total: number
  max: number
  overflow: boolean
}

interface Ticket {
  id: string
  extId: string
  conn: MessageConnection
  fd: number
  size: number
  bytes: number
  calls: number
  byteBudget: number
  callBudget: number
  cancel: CancellationTokenSource
  overBudget: boolean
  dead: boolean
  reading: number
  waiting: Array<() => void>
  drained: (() => void) | null
  listing?: Listing
  chunks?: Chunks
}

type Exchange<T> = { ok: true; value: T } | { ok: false; error: string }

function textBytes(value: string): number {
  return Buffer.byteLength(value)
}

function validEntry(entry: unknown, limits: BrowseLimits): entry is RawEntry {
  if (!isRecord(entry)) return false
  const { name, dir, size, encrypted, link } = entry
  if (typeof name !== 'string' || textBytes(name) > BROWSE_NAME_BYTES) return false
  if (typeof dir !== 'boolean' || typeof encrypted !== 'boolean') return false
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return false
  if (link === null) return true
  return typeof link === 'string' && textBytes(link) <= limits.linkTargetBytes
}

function readProblem(error: string): Extract<EntryRead, { ok: false }>['problem'] {
  if (error === 'encrypted' || error === 'link' || error === 'gone' || error === 'too-large') {
    return error
  }
  return error === 'limit' ? 'unzip-limit' : 'unreadable'
}

export class ExtensionBrowse implements BrowseProviders {
  private readonly tickets = new Map<string, Ticket>()
  private readonly running = new Map<string, number>()
  private readonly waiting = new Map<string, Array<() => void>>()

  constructor(
    private readonly host: ExtensionBrowseHost,
    private readonly timing: ExtensionBrowseTiming = {
      listGraceMs: LIST_GRACE_MS,
      readMs: READ_DEADLINE_MS,
      killGraceMs: BROWSE_KILL_GRACE_MS,
    },
  ) {}

  kindFor(name: string): { extId: string; kind: string } | null {
    const found = browseKindFor(name, this.host.candidates())
    return found ? { extId: found.extId, kind: found.kind.id } : null
  }

  browsable(): (name: string) => boolean {
    const candidates = this.host.candidates()
    return (name) => browseKindFor(name, candidates) !== null
  }

  kindsSignature(): string {
    return this.host
      .candidates()
      .map(
        (c) => `${c.extId}:${c.kind.id}:${c.kind.selector.map((s) => s.filenamePattern).join(',')}`,
      )
      .sort()
      .join('|')
  }

  async list(
    target: BrowseTarget,
    limits: BrowseLimits,
    signal: AbortSignal,
  ): Promise<ProviderListing> {
    const params = (ticket: string): BrowseListParams => ({
      ticket,
      kind: target.kind,
      size: target.size,
      limits,
    })
    const outcome = await this.exchange<BrowseListResult>(
      target,
      limits.scanMs + this.timing.listGraceMs,
      signal,
      (ticket) => {
        ticket.listing = { entries: [], bytes: 0, limits, failed: false, cut: false }
      },
      (conn, ticket) =>
        conn.sendRequest(BROWSE_LIST_METHOD, params(ticket.id), ticket.cancel.token),
    )
    if (!outcome.ok) return outcome
    const { result, ticket } = outcome.value
    const listing = ticket.listing
    if (!listing || listing.failed) return { ok: false, error: 'invalid' }
    if (!isRecord(result)) return { ok: false, error: 'failed' }
    if (result.ok === true) return { ok: true, entries: listing.entries, cut: listing.cut }
    const error = typeof result.error === 'string' ? result.error : 'failed'
    if (error === 'limit' && listing.entries.length > 0) {
      return { ok: true, entries: listing.entries, cut: true }
    }
    return { ok: false, error }
  }

  async read(
    target: BrowseTarget,
    index: number,
    max: number,
    limits: BrowseLimits,
    signal: AbortSignal,
  ): Promise<EntryRead> {
    const params = (ticket: string): BrowseReadParams => ({
      ticket,
      kind: target.kind,
      size: target.size,
      limits,
      index,
      max,
    })
    const outcome = await this.exchange<BrowseReadResult>(
      target,
      this.timing.readMs,
      signal,
      (ticket) => {
        ticket.chunks = { parts: [], total: 0, max, overflow: false }
      },
      (conn, ticket) =>
        conn.sendRequest(BROWSE_READ_METHOD, params(ticket.id), ticket.cancel.token),
    )
    if (!outcome.ok) return { ok: false, problem: 'unreadable' }
    const { result, ticket } = outcome.value
    const chunks = ticket.chunks
    if (!chunks || chunks.overflow) return { ok: false, problem: 'too-large' }
    if (isRecord(result) && result.ok === true)
      return { ok: true, data: Buffer.concat(chunks.parts) }
    const error = isRecord(result) && typeof result.error === 'string' ? result.error : 'failed'
    return { ok: false, problem: readProblem(error) }
  }

  private async acquire(extId: string): Promise<(() => void) | null> {
    const release = (): void => {
      const next = this.waiting.get(extId)?.shift()
      if (next) next()
      else this.running.set(extId, (this.running.get(extId) ?? 1) - 1)
    }
    const active = this.running.get(extId) ?? 0
    if (active < MAX_IN_FLIGHT) {
      this.running.set(extId, active + 1)
      return release
    }
    const queue = this.waiting.get(extId) ?? []
    if (queue.length >= MAX_QUEUED) return null
    this.waiting.set(extId, queue)
    await new Promise<void>((resolve) => queue.push(resolve))
    return release
  }

  private async exchange<T>(
    target: BrowseTarget,
    deadlineMs: number,
    signal: AbortSignal,
    prepare: (ticket: Ticket) => void,
    send: (conn: MessageConnection, ticket: Ticket) => Promise<T>,
  ): Promise<Exchange<{ result: T; ticket: Ticket }>> {
    const release = await this.acquire(target.extId)
    if (!release) return { ok: false, error: 'busy' }
    let ticket: Ticket | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      let conn: MessageConnection
      try {
        conn = await this.host.connected(target.extId)
      } catch {
        return { ok: false, error: 'no-provider' }
      }
      if (signal.aborted) return { ok: false, error: 'cancelled' }
      const proc = this.host.process(target.extId)
      const made: Ticket = {
        id: randomBytes(16).toString('hex'),
        extId: target.extId,
        conn,
        fd: target.fd,
        size: target.size,
        bytes: 0,
        calls: 0,
        byteBudget: browseReadBudget(target.size),
        callBudget: browseCallBudget(target.size),
        cancel: new CancellationTokenSource(),
        overBudget: false,
        dead: false,
        reading: 0,
        waiting: [],
        drained: null,
      }
      ticket = made
      prepare(made)
      this.tickets.set(made.id, made)
      signal.addEventListener('abort', () => made.cancel.cancel(), { once: true })
      let settled = false
      const request = send(conn, made).finally(() => {
        settled = true
      })
      request.catch(() => {})
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          made.cancel.cancel()
          setTimeout(() => {
            if (!settled && this.host.process(target.extId) === proc) {
              this.host.recycle(target.extId)
            }
          }, this.timing.killGraceMs).unref()
          resolve('timeout')
        }, deadlineMs)
      })
      const raced = await Promise.race([request, deadline]).catch(() => 'failed' as const)
      if (raced === 'timeout') return { ok: false, error: 'timeout' }
      if (raced === 'failed') return { ok: false, error: 'failed' }
      if (made.overBudget) return { ok: false, error: 'over-budget' }
      return { ok: true, value: { result: raced, ticket: made } }
    } finally {
      clearTimeout(timer)
      if (ticket) {
        this.tickets.delete(ticket.id)
        await this.drain(ticket)
      }
      release()
    }
  }

  private async drain(ticket: Ticket): Promise<void> {
    ticket.dead = true
    for (const start of ticket.waiting.splice(0)) start()
    if (ticket.reading === 0) return
    await new Promise<void>((resolve) => {
      ticket.drained = resolve
    })
  }

  private pump(ticket: Ticket): void {
    while (ticket.reading < READS_AT_ONCE && ticket.waiting.length > 0) ticket.waiting.shift()?.()
  }

  private readBlock(ticket: Ticket, offset: number, length: number): Promise<BrowseReadAtResult> {
    return new Promise((resolve) => {
      ticket.waiting.push(() => {
        if (ticket.dead) {
          resolve({ ok: false, error: 'unknown-ticket' })
          return
        }
        ticket.reading += 1
        const buffer = Buffer.alloc(length)
        read(ticket.fd, buffer, 0, length, offset, (error, bytes) => {
          ticket.reading -= 1
          if (error || bytes !== length) resolve({ ok: false, error: 'out-of-range' })
          else resolve({ ok: true, data: buffer.toString('base64') })
          if (ticket.reading === 0 && ticket.drained) ticket.drained()
          else this.pump(ticket)
        })
      })
      this.pump(ticket)
    })
  }

  private ticketOf(identity: PaneIdentity, conn: MessageConnection, id: unknown): Ticket | null {
    const ticket = typeof id === 'string' ? this.tickets.get(id) : undefined
    return ticket && ticket.extId === identity.extId && ticket.conn === conn ? ticket : null
  }

  readAt(
    identity: PaneIdentity,
    conn: MessageConnection,
    raw: unknown,
  ): Promise<BrowseReadAtResult> {
    const params = raw as Partial<BrowseReadAtParams> | null
    const ticket = this.ticketOf(identity, conn, params?.ticket)
    if (!ticket) return Promise.resolve({ ok: false, error: 'unknown-ticket' })
    const { offset, length } = params ?? {}
    if (
      typeof offset !== 'number' ||
      typeof length !== 'number' ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 1 ||
      length > BROWSE_READ_MAX
    ) {
      return Promise.resolve({ ok: false, error: 'invalid' })
    }
    if (offset + length > ticket.size) return Promise.resolve({ ok: false, error: 'out-of-range' })
    const last = offset + length === ticket.size
    if (offset % BROWSE_READ_MAX !== 0 || (length !== BROWSE_READ_MAX && !last)) {
      return Promise.resolve({ ok: false, error: 'unaligned' })
    }
    ticket.calls += 1
    ticket.bytes += length
    if (ticket.calls > ticket.callBudget || ticket.bytes > ticket.byteBudget) {
      ticket.overBudget = true
      ticket.cancel.cancel()
      return Promise.resolve({ ok: false, error: 'over-budget' })
    }
    return this.readBlock(ticket, offset, length)
  }

  entries(identity: PaneIdentity, conn: MessageConnection, raw: unknown): BrowseFlowResult {
    const params = raw as Partial<BrowseEntriesParams> | null
    const ticket = this.ticketOf(identity, conn, params?.ticket)
    const listing = ticket?.listing
    if (!ticket || !listing) return { ok: false, error: 'unknown-ticket' }
    const page = params?.entries
    if (!Array.isArray(page) || page.length > BROWSE_PAGE_ENTRIES) return this.fail(ticket)
    for (const entry of page) {
      if (!validEntry(entry, listing.limits)) return this.fail(ticket)
      if (listing.entries.length > listing.limits.entries) {
        listing.cut = true
        return { ok: true, more: false }
      }
      listing.bytes += textBytes(entry.name) + (entry.link === null ? 0 : textBytes(entry.link))
      if (listing.bytes > BROWSE_LISTING_BYTES) {
        listing.cut = true
        return { ok: true, more: false }
      }
      listing.entries.push({
        name: entry.name,
        index: listing.entries.length,
        dir: entry.dir,
        size: entry.size,
        encrypted: entry.encrypted,
        link: entry.link,
      })
    }
    const more = listing.entries.length <= listing.limits.entries
    if (!more) listing.cut = true
    return { ok: true, more }
  }

  chunk(identity: PaneIdentity, conn: MessageConnection, raw: unknown): BrowseFlowResult {
    const params = raw as Partial<BrowseChunkParams> | null
    const ticket = this.ticketOf(identity, conn, params?.ticket)
    const chunks = ticket?.chunks
    if (!ticket || !chunks) return { ok: false, error: 'unknown-ticket' }
    if (typeof params?.data !== 'string' || params.data.length > BROWSE_READ_MAX * 2) {
      return { ok: false, error: 'invalid' }
    }
    if (chunks.overflow) return { ok: true, more: false }
    const data = Buffer.from(params.data, 'base64')
    if (data.length > BROWSE_READ_MAX) return { ok: false, error: 'invalid' }
    chunks.total += data.length
    if (chunks.total > chunks.max) {
      chunks.overflow = true
      chunks.parts = []
      return { ok: true, more: false }
    }
    chunks.parts.push(data)
    return { ok: true, more: true }
  }

  private fail(ticket: Ticket): { ok: false; error: BrowseCallError } {
    if (ticket.listing) ticket.listing.failed = true
    ticket.cancel.cancel()
    return { ok: false, error: 'invalid' }
  }
}
