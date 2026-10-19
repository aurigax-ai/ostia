import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc/node'
import {
  BROWSE_CACHE_BLOCKS,
  BROWSE_CHUNK_METHOD,
  BROWSE_ENTRIES_METHOD,
  BROWSE_LIST_METHOD,
  BROWSE_PAGE_BYTES,
  BROWSE_PAGE_ENTRIES,
  BROWSE_READ_AT_METHOD,
  BROWSE_READ_MAX,
  BROWSE_READ_METHOD,
  type BrowseChunkParams,
  type BrowseEntriesParams,
  type BrowseEntry,
  type BrowseFlowResult,
  type BrowseLimits,
  type BrowseListError,
  type BrowseListParams,
  type BrowseListResult,
  type BrowseReadAtParams,
  type BrowseReadAtResult,
  type BrowseReadError,
  type BrowseReadParams,
  type BrowseReadResult,
} from '../contract/fileBrowse'
import { isRecord } from '../contract/isRecord'

export interface BrowseFile {
  readonly size: number
  readAt(offset: number, length: number): Promise<Uint8Array>
  stream(start?: number, end?: number): Readable
}

export interface EntrySink {
  add(entry: BrowseEntry): Promise<boolean>
}

export interface ChunkSink {
  write(bytes: Uint8Array): Promise<boolean>
}

export interface BrowseContext {
  signal: AbortSignal
  limits: BrowseLimits
}

export interface BrowseProvider {
  list(file: BrowseFile, sink: EntrySink, context: BrowseContext): Promise<BrowseListResult>
  read(
    file: BrowseFile,
    index: number,
    sink: ChunkSink,
    context: BrowseContext & { max: number },
  ): Promise<BrowseReadResult>
}

export class BrowseError extends Error {
  constructor(
    readonly code: BrowseListError | BrowseReadError,
    message?: string,
  ) {
    super(message ?? code)
  }
}

class Cancelled extends Error {}

const LIST_ERRORS: readonly string[] = [
  'unsupported',
  'corrupt',
  'limit',
  'cancelled',
  'failed',
  'encrypted',
] satisfies BrowseListError[]
const READ_ERRORS: readonly string[] = [
  'gone',
  'encrypted',
  'link',
  'too-large',
  'limit',
  'corrupt',
  'cancelled',
  'failed',
] satisfies BrowseReadError[]

function failureCode(err: unknown, allowed: readonly string[], signal: AbortSignal): string {
  if (signal.aborted || err instanceof Cancelled) return 'cancelled'
  if (err instanceof BrowseError && allowed.includes(err.code)) return err.code
  return 'failed'
}

function guard(result: BrowseFlowResult | BrowseReadAtResult): void {
  if (!result.ok) throw new Cancelled(result.error)
}

export function blockCache(
  size: number,
  fetchBlock: (start: number, length: number) => Promise<Uint8Array>,
): Pick<BrowseFile, 'readAt' | 'stream'> {
  const blocks = new Map<number, Promise<Uint8Array>>()
  const block = (index: number): Promise<Uint8Array> => {
    const cached = blocks.get(index)
    if (cached) {
      blocks.delete(index)
      blocks.set(index, cached)
      return cached
    }
    const start = index * BROWSE_READ_MAX
    const fetched = fetchBlock(start, Math.min(BROWSE_READ_MAX, size - start))
    fetched.catch(() => blocks.delete(index))
    blocks.set(index, fetched)
    while (blocks.size > BROWSE_CACHE_BLOCKS) {
      const oldest = blocks.keys().next().value
      if (oldest === undefined) break
      blocks.delete(oldest)
    }
    return fetched
  }
  const readAt = async (offset: number, length: number): Promise<Uint8Array> => {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0
    ) {
      throw new RangeError('offset and length must be non-negative integers')
    }
    if (offset + length > size) throw new RangeError('read past the end of the file')
    const out = new Uint8Array(length)
    let done = 0
    while (done < length) {
      const at = offset + done
      const index = Math.floor(at / BROWSE_READ_MAX)
      const data = await block(index)
      const inside = at - index * BROWSE_READ_MAX
      const take = Math.min(length - done, data.length - inside)
      if (take <= 0) throw new RangeError('short block')
      out.set(data.subarray(inside, inside + take), done)
      done += take
    }
    return out
  }
  const stream = (start = 0, end = size): Readable => {
    const last = Math.min(end, size)
    async function* pieces(): AsyncGenerator<Uint8Array> {
      let at = start
      let ahead: Promise<Uint8Array> | null = null
      while (at < last) {
        const index = Math.floor(at / BROWSE_READ_MAX)
        const current = ahead ?? block(index)
        ahead = (index + 1) * BROWSE_READ_MAX < last ? block(index + 1) : null
        ahead?.catch(() => {})
        const data = await current
        const inside = at - index * BROWSE_READ_MAX
        const upTo = Math.min(data.length, last - index * BROWSE_READ_MAX)
        yield data.subarray(inside, upTo)
        at = index * BROWSE_READ_MAX + upTo
      }
    }
    return Readable.from(pieces(), { objectMode: false })
  }
  return { readAt, stream }
}

function openFile(
  conn: MessageConnection,
  ticket: string,
  size: number,
  token: CancellationToken,
): BrowseFile {
  const fetchBlock = async (offset: number, length: number): Promise<Uint8Array> => {
    if (token.isCancellationRequested) throw new Cancelled('cancelled')
    const params: BrowseReadAtParams = { ticket, offset, length }
    const reply = await conn.sendRequest<BrowseReadAtResult>(BROWSE_READ_AT_METHOD, params)
    guard(reply)
    return new Uint8Array(Buffer.from((reply as { data: string }).data, 'base64'))
  }
  return { size, ...blockCache(size, fetchBlock) }
}

function entrySink(conn: MessageConnection, ticket: string) {
  let page: BrowseEntry[] = []
  let bytes = 0
  let more = true
  const flush = async (): Promise<void> => {
    if (page.length === 0) return
    const params: BrowseEntriesParams = { ticket, entries: page }
    page = []
    bytes = 0
    const reply = await conn.sendRequest<BrowseFlowResult>(BROWSE_ENTRIES_METHOD, params)
    guard(reply)
    more = (reply as { more: boolean }).more
  }
  const sink: EntrySink = {
    add: async (entry) => {
      if (!more) return false
      page.push(entry)
      bytes += entry.name.length + (entry.link?.length ?? 0) + 64
      if (page.length >= BROWSE_PAGE_ENTRIES || bytes >= BROWSE_PAGE_BYTES) await flush()
      return more
    },
  }
  return { sink, flush, stopped: () => !more }
}

function chunkSink(conn: MessageConnection, ticket: string): ChunkSink {
  let more = true
  return {
    write: async (bytes) => {
      for (let at = 0; more && at < bytes.length; at += BROWSE_READ_MAX) {
        const params: BrowseChunkParams = {
          ticket,
          data: Buffer.from(bytes.subarray(at, at + BROWSE_READ_MAX)).toString('base64'),
        }
        const reply = await conn.sendRequest<BrowseFlowResult>(BROWSE_CHUNK_METHOD, params)
        guard(reply)
        more = (reply as { more: boolean }).more
      }
      return more
    },
  }
}

function abortOn(token: CancellationToken): AbortController {
  const abort = new AbortController()
  token.onCancellationRequested(() => abort.abort())
  if (token.isCancellationRequested) abort.abort()
  return abort
}

function isListParams(params: unknown): params is BrowseListParams {
  return (
    isRecord(params) &&
    typeof params.ticket === 'string' &&
    typeof params.kind === 'string' &&
    typeof params.size === 'number' &&
    isRecord(params.limits)
  )
}

const REGISTRATION_WAIT_MS = 10
const REGISTRATION_TRIES = 20

async function providerFor(
  providers: ReadonlyMap<string, BrowseProvider>,
  kind: string,
): Promise<BrowseProvider | undefined> {
  for (let tries = 0; tries < REGISTRATION_TRIES; tries++) {
    const found = providers.get(kind)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, REGISTRATION_WAIT_MS))
  }
  return undefined
}

export function listenForBrowse(
  conn: MessageConnection,
  providers: ReadonlyMap<string, BrowseProvider>,
): void {
  conn.onRequest(
    BROWSE_LIST_METHOD,
    async (params: BrowseListParams, token: CancellationToken): Promise<BrowseListResult> => {
      const provider = isListParams(params) ? await providerFor(providers, params.kind) : undefined
      if (!provider) return { ok: false, error: 'unsupported' }
      const abort = abortOn(token)
      const entries = entrySink(conn, params.ticket)
      try {
        const file = openFile(conn, params.ticket, params.size, token)
        const result = await provider.list(file, entries.sink, {
          signal: abort.signal,
          limits: params.limits,
        })
        await entries.flush()
        if (result.ok && entries.stopped()) return { ok: true, complete: false }
        return result
      } catch (err) {
        return { ok: false, error: failureCode(err, LIST_ERRORS, abort.signal) as BrowseListError }
      }
    },
  )
  conn.onRequest(
    BROWSE_READ_METHOD,
    async (params: BrowseReadParams, token: CancellationToken): Promise<BrowseReadResult> => {
      const provider = isListParams(params) ? await providerFor(providers, params.kind) : undefined
      if (!provider || !Number.isSafeInteger(params.index) || !Number.isSafeInteger(params.max)) {
        return { ok: false, error: 'failed' }
      }
      const abort = abortOn(token)
      try {
        const file = openFile(conn, params.ticket, params.size, token)
        return await provider.read(file, params.index, chunkSink(conn, params.ticket), {
          signal: abort.signal,
          limits: params.limits,
          max: params.max,
        })
      } catch (err) {
        return { ok: false, error: failureCode(err, READ_ERRORS, abort.signal) as BrowseReadError }
      }
    },
  )
}

export function declaresBrowseKind(extensionDir: string, kindId: string): boolean {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(extensionDir, 'ostia.json'), 'utf8'))
    const contributes = isRecord(manifest) ? manifest.contributes : undefined
    const kinds = isRecord(contributes) ? contributes.fileKinds : undefined
    return (
      Array.isArray(kinds) &&
      kinds.some((kind) => isRecord(kind) && kind.id === kindId && isRecord(kind.browse))
    )
  } catch {
    return false
  }
}
