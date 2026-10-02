import {
  type FilesHandler,
  REMOTE_ENTRIES_MAX,
  REMOTE_FILE_MAX_BYTES,
  type RemoteEntry,
  type RemoteFileError,
  type RemoteFilesRequest,
  type RemoteFilesResult,
} from '../sdk'
import { type HelperChannel, HelperFailure } from './channel'
import type { HelperHosts } from './helperHosts'
import { type ConnectPlan, hostKey } from './plan'

export const LIST_BYTES_MAX = 2 * 1024 * 1024
export const SESSIONS_MAX = 256
const VERSION_PATTERN = /^\d{1,10}-\d{1,12}$/
const STAT_FILE_PATTERN = /^f:\d{1,15}:(\d{1,10}-\d{1,12}|-)$/

export class Sessions {
  private readonly byPane = new Map<string, ConnectPlan>()

  opened(paneId: string, plan: ConnectPlan): void {
    if (this.byPane.size >= SESSIONS_MAX) {
      const oldest = this.byPane.keys().next().value
      if (oldest !== undefined) this.byPane.delete(oldest)
    }
    this.byPane.set(paneId, plan)
  }

  closed(paneId: string): void {
    this.byPane.delete(paneId)
  }

  planOf(paneId: string | undefined): ConnectPlan | undefined {
    return paneId ? this.byPane.get(paneId) : undefined
  }
}

function fail(error: RemoteFileError): RemoteFilesResult {
  return { ok: false, error }
}

const SAME_ERRORS: readonly string[] = [
  'not-found',
  'outside',
  'not-file',
  'not-dir',
  'too-large',
  'changed',
  'denied',
]

function failureOf(err: unknown): RemoteFilesResult {
  if (!(err instanceof HelperFailure)) return fail('failed')
  if (SAME_ERRORS.includes(err.code)) return fail(err.code as RemoteFileError)
  if (err.code === 'symlink') return fail('denied')
  if (err.code === 'bad-request' || err.code === 'failed') return fail('failed')
  return fail('unavailable')
}

export function parseListing(payload: Buffer): RemoteEntry[] {
  const entries: RemoteEntry[] = []
  for (const line of payload.toString('utf8').split('\n')) {
    const kind = line.slice(0, 2)
    if ((kind !== 'd ' && kind !== 'f ') || line.length < 3) continue
    entries.push({ name: line.slice(2), dir: kind === 'd ' })
  }
  return entries
}

function decodeText(payload: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload)
    return text.includes('\u0000') ? null : text
  } catch {
    return null
  }
}

async function answer(channel: HelperChannel, req: RemoteFilesRequest): Promise<RemoteFilesResult> {
  const { root, path } = req
  switch (req.op) {
    case 'list': {
      const reply = await channel.request({
        op: 'list',
        number: REMOTE_ENTRIES_MAX,
        root,
        path,
        maxReply: LIST_BYTES_MAX,
      })
      return {
        ok: true,
        entries: parseListing(reply.payload),
        truncated: reply.meta === 'truncated',
      }
    }
    case 'stat': {
      const reply = await channel.request({
        op: 'stat',
        number: REMOTE_FILE_MAX_BYTES,
        root,
        path,
        maxReply: 0,
      })
      if (reply.meta === 'd') return { ok: true, kind: 'dir' }
      const match = STAT_FILE_PATTERN.exec(reply.meta)
      if (!match) return fail('failed')
      return match[1] === '-'
        ? { ok: true, kind: 'file' }
        : { ok: true, kind: 'file', version: match[1] }
    }
    case 'read': {
      const reply = await channel.request({
        op: 'read',
        number: REMOTE_FILE_MAX_BYTES,
        root,
        path,
        maxReply: REMOTE_FILE_MAX_BYTES,
      })
      if (!VERSION_PATTERN.test(reply.meta)) return fail('failed')
      const content = decodeText(reply.payload)
      return content === null ? fail('binary') : { ok: true, content, version: reply.meta }
    }
    case 'write': {
      if (typeof req.content !== 'string' || typeof req.baseVersion !== 'string') {
        return fail('failed')
      }
      const payload = Buffer.from(req.content, 'utf8')
      if (payload.length > REMOTE_FILE_MAX_BYTES) return fail('too-large')
      const reply = await channel.request({
        op: 'write',
        number: payload.length,
        version: req.baseVersion,
        root,
        path,
        payload,
        maxReply: 0,
      })
      return VERSION_PATTERN.test(reply.meta) ? { ok: true, version: reply.meta } : fail('failed')
    }
    default:
      return fail('failed')
  }
}

export class HelperFolders {
  private readonly open = new Map<string, ConnectPlan>()

  constructor(private readonly hosts: HelperHosts) {}

  add(folderId: string, plan: ConnectPlan): void {
    if (this.open.has(folderId)) return
    this.open.set(folderId, plan)
    this.hosts.retain(hostKey(plan))
  }

  remove(folderId: string): void {
    const plan = this.open.get(folderId)
    if (!plan) return
    this.open.delete(folderId)
    this.hosts.release(hostKey(plan))
  }

  idsOn(key: string): string[] {
    return [...this.open].filter(([, plan]) => hostKey(plan) === key).map(([id]) => id)
  }

  readonly handle: FilesHandler = async (req) => {
    const plan = this.open.get(req.folderId)
    if (!plan) return fail('unknown-folder')
    try {
      return await answer(await this.hosts.channel(plan), req)
    } catch (err) {
      return failureOf(err)
    }
  }
}
