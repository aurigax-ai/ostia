import { lastTurns, type StreamEnd, turnsStarted } from '../../shared/agents/agentStream'
import { ClaudeStream } from '../../shared/agents/claudeStream'
import { isErrno, reportError } from '../diagnostics/errorReport'
import type { StreamSource } from './streamSource'
import { readNewLines, readTailWindow } from './transcriptFiles'

const TAIL_BYTES = 4 * 1024 * 1024
const FULL_BYTES = 32 * 1024 * 1024
const WIDEN = 4
const TAIL_POLL_MS = 300
const FAILURES_MAX = 20

export interface ClaudeSourceDeps {
  find: () => Promise<string | null>
  session: string
  closed: (reason: StreamEnd) => void
}

export function claudeSource({ find, session, closed }: ClaudeSourceDeps): StreamSource {
  let parser = new ClaudeStream()
  let path: string | null = null
  let offset = 0
  let shown = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let busy = false
  let failures = 0

  async function load(turns: number) {
    path = await find()
    if (!path) return { events: [], truncated: false }
    for (let bytes = TAIL_BYTES; ; bytes = Math.min(bytes * WIDEN, FULL_BYTES)) {
      const read = await readTailWindow(path, bytes).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null
        throw err
      })
      if (!read) return { events: [], truncated: false }
      parser = new ClaudeStream()
      const events = parser.feed(read.lines)
      const enough = !read.truncated || turnsStarted(events) > turns
      if (enough || bytes >= FULL_BYTES) {
        offset = read.end
        return { events: lastTurns(events, turns), truncated: !enough }
      }
    }
  }

  return {
    backfill: (turns) => {
      shown = turns
      return load(turns)
    },
    live: (emit) => {
      timer = setInterval(async () => {
        if (busy) return
        busy = true
        try {
          path ??= await find()
          if (!path) return
          const read = await readNewLines(path, offset)
          if (read.reset) {
            const again = await load(shown)
            emit([{ type: 'session', session }, ...again.events, { type: 'live' }])
          } else {
            offset = read.end
            const events = parser.feed(read.lines)
            if (events.length > 0) emit(events)
          }
          failures = 0
        } catch (err) {
          if (!isErrno(err)) reportError('streamClaude', err)
          failures = isErrno(err) ? failures + 1 : FAILURES_MAX
          if (failures >= FAILURES_MAX) {
            if (timer) clearInterval(timer)
            timer = null
            closed('unavailable')
          }
        } finally {
          busy = false
        }
      }, TAIL_POLL_MS)
    },
    close: () => {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
