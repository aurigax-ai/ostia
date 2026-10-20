import { lastTurns, turnsStarted } from '../../shared/agents/agentStream'
import { ClaudeStream } from '../../shared/agents/claudeStream'
import type { StreamSource } from './streamSource'
import { readNewLines, readTailWindow } from './transcriptFiles'

const TAIL_BYTES = 4 * 1024 * 1024
const FULL_BYTES = 32 * 1024 * 1024
const WIDEN = 4
const TAIL_POLL_MS = 300

export function claudeSource(find: () => string | null): StreamSource {
  let parser = new ClaudeStream()
  let path: string | null = null
  let offset = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let busy = false

  return {
    backfill: async (turns) => {
      path = find()
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
    },
    live: (emit) => {
      timer = setInterval(async () => {
        if (busy) return
        busy = true
        try {
          path ??= find()
          if (!path) return
          const read = await readNewLines(path, offset)
          offset = read.end
          const events = parser.feed(read.lines)
          if (events.length > 0) emit(events)
        } catch {
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
