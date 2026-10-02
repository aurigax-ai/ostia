import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  CHAT_SESSIONS_MAX,
  CHAT_SESSION_ID_PATTERN,
  CHAT_SESSION_MAX_BYTES,
  CHAT_TOTAL_MAX_BYTES,
  type ChatSaveResult,
  type ChatSession,
  type ChatSessionSummary,
  chatSummary,
  chatTitle,
  normalizeChatSession,
  toolCallIdsOf,
} from '../shared/chatSessions'

export interface ChatSessionStoreOptions {
  dir: string
  sessionMaxBytes?: number
  totalMaxBytes?: number
  maxSessions?: number
}

export interface ChatSessionStore {
  list: () => ChatSessionSummary[]
  get: (id: string) => ChatSession | null
  save: (raw: unknown) => ChatSaveResult
  rename: (id: string, title: string) => ChatSessionSummary | null
  remove: (id: string) => boolean
}

function sizeOf(session: ChatSession): number {
  return Buffer.byteLength(JSON.stringify(session))
}

function dropOrphanEdits(session: ChatSession): void {
  if (!session.edits) return
  const calls = toolCallIdsOf(session.messages)
  const kept = session.edits.filter((e) => calls.has(e.toolCallId))
  session.edits = kept.length > 0 ? kept : undefined
}

export function trimSession(session: ChatSession, maxBytes: number): number {
  let dropped = 0
  while (session.messages.length > 1 && sizeOf(session) > maxBytes) {
    session.messages.shift()
    dropped += 1
    dropOrphanEdits(session)
  }
  while (session.messages.length > 0 && session.messages[0].role !== 'user') {
    session.messages.shift()
    dropped += 1
  }
  dropOrphanEdits(session)
  if (dropped > 0) session.trimmed = true
  session.messageCount = session.messages.length
  return dropped
}

export function createChatSessionStore(opts: ChatSessionStoreOptions): ChatSessionStore {
  const sessionMax = opts.sessionMaxBytes ?? CHAT_SESSION_MAX_BYTES
  const totalMax = opts.totalMaxBytes ?? CHAT_TOTAL_MAX_BYTES
  const maxSessions = opts.maxSessions ?? CHAT_SESSIONS_MAX
  const file = (id: string): string => join(opts.dir, `${id}.json`)

  const ensureDir = (): void => {
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 })
  }

  const read = (id: string): ChatSession | null => {
    if (!CHAT_SESSION_ID_PATTERN.test(id)) return null
    try {
      const session = normalizeChatSession(JSON.parse(readFileSync(file(id), 'utf8')))
      return session?.id === id ? session : null
    } catch {
      return null
    }
  }

  const ids = (): string[] => {
    if (!existsSync(opts.dir)) return []
    return readdirSync(opts.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .filter((id) => CHAT_SESSION_ID_PATTERN.test(id))
  }

  const write = (session: ChatSession): void => {
    ensureDir()
    const tmp = `${file(session.id)}.tmp`
    writeFileSync(tmp, JSON.stringify(session), { mode: 0o600 })
    renameSync(tmp, file(session.id))
  }

  const evict = (keep: string): string[] => {
    const entries = ids()
      .map((id) => {
        try {
          const stat = statSync(file(id))
          const session = read(id)
          return { id, size: stat.size, updatedAt: session?.updatedAt ?? 0 }
        } catch {
          return null
        }
      })
      .filter((e): e is { id: string; size: number; updatedAt: number } => e !== null)
      .sort((a, b) => a.updatedAt - b.updatedAt)
    let total = entries.reduce((sum, e) => sum + e.size, 0)
    let count = entries.length
    const evicted: string[] = []
    for (const entry of entries) {
      if (total <= totalMax && count <= maxSessions) break
      if (entry.id === keep) continue
      rmSync(file(entry.id), { force: true })
      total -= entry.size
      count -= 1
      evicted.push(entry.id)
    }
    return evicted
  }

  return {
    list: () =>
      ids()
        .map(read)
        .filter((s): s is ChatSession => s !== null)
        .map(chatSummary)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    get: read,
    save: (raw) => {
      const session = normalizeChatSession(raw)
      if (!session) return { ok: false, error: 'invalid-session' }
      const trimmedMessages = trimSession(session, sessionMax)
      write(session)
      return {
        ok: true,
        summary: chatSummary(session),
        trimmedMessages,
        evicted: evict(session.id),
      }
    },
    rename: (id, title) => {
      const session = read(id)
      const next = chatTitle(title)
      if (!session || !next) return null
      session.title = next
      write(session)
      return chatSummary(session)
    },
    remove: (id) => {
      if (!CHAT_SESSION_ID_PATTERN.test(id) || !existsSync(file(id))) return false
      rmSync(file(id), { force: true })
      return true
    },
  }
}
