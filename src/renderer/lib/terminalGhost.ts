import type {
  TerminalAssistRequest,
  TerminalContextEntry,
  TerminalHistoryEntry,
} from '@shared/assist'
import { TERMINAL_LINE_MAX } from '@shared/assist'
import { LRUCache } from 'lru-cache'
import type { CommandBlock } from '../stores/blocksStore'
import { NATURAL_COMMAND_PATTERN } from './assistComposer'
import type { ShownPaneChip } from './paneChips'

export const GHOST_DEBOUNCE_MS = 300
export const GHOST_CACHE_MAX = 100
export const GHOST_HISTORY_MAX = 5

export interface AiGhost {
  line: string
  text: string
}

export interface GhostBlockers {
  composing: boolean
  vimNormal: boolean
  menuOpen: boolean
  naturalOpen: boolean
  walking: boolean
  collapsed: boolean
  caretAtEnd: boolean
  dismissed: boolean
}

export type Ghost = { kind: 'history' | 'ai'; text: string } | null

export function ghostBlocked(b: GhostBlockers): boolean {
  return (
    b.composing ||
    b.vimNormal ||
    b.menuOpen ||
    b.naturalOpen ||
    b.walking ||
    !b.collapsed ||
    !b.caretAtEnd ||
    b.dismissed
  )
}

export function aiContinuation(text: string, ai: AiGhost | null): string {
  if (!ai || !ai.text) return ''
  const full = ai.line + ai.text
  if (!text.startsWith(ai.line) || !full.startsWith(text)) return ''
  return full.slice(text.length)
}

export function pickGhost(
  text: string,
  blockers: GhostBlockers,
  history: string,
  ai: AiGhost | null,
): Ghost {
  if (!text || ghostBlocked(blockers)) return null
  if (history) return { kind: 'history', text: history }
  const rest = aiContinuation(text, ai)
  return rest ? { kind: 'ai', text: rest } : null
}

export function ghostEligible(text: string): boolean {
  return (
    text.trim().length > 0 &&
    text.length <= TERMINAL_LINE_MAX &&
    !text.includes('\n') &&
    !NATURAL_COMMAND_PATTERN.test(text) &&
    !text.startsWith('#')
  )
}

export function recentHistory(
  blocks: readonly CommandBlock[] | undefined,
  max = GHOST_HISTORY_MAX,
): TerminalHistoryEntry[] {
  return (blocks ?? [])
    .filter((b) => b.command.trim() && b.endLine)
    .slice(-max)
    .map((b) =>
      b.exitCode === null ? { command: b.command } : { command: b.command, exitCode: b.exitCode },
    )
}

export function chipContext(chips: readonly ShownPaneChip[]): TerminalContextEntry[] {
  return chips.map((c) => ({ label: c.title, text: c.text }))
}

export function terminalRequest(
  line: string,
  opts: {
    cwd?: string
    platform?: string
    history: TerminalHistoryEntry[]
    context: TerminalContextEntry[]
  },
): TerminalAssistRequest {
  const req: TerminalAssistRequest = { line }
  if (opts.cwd) req.cwd = opts.cwd
  if (opts.platform) req.platform = opts.platform
  if (opts.history.length > 0) req.history = opts.history
  if (opts.context.length > 0) req.context = opts.context
  return req
}

export interface GhostRequester {
  request: (line: string) => void
  cancel: () => void
}

export function ghostRequester(
  fetch: (line: string, signal: AbortSignal) => Promise<string | null>,
  onResult: (ghost: AiGhost) => void,
  delayMs = GHOST_DEBOUNCE_MS,
): GhostRequester {
  const cache = new LRUCache<string, string>({ max: GHOST_CACHE_MAX })
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    controller?.abort()
    controller = undefined
  }
  return {
    request: (line) => {
      cancel()
      const known = cache.get(line)
      if (known !== undefined) {
        onResult({ line, text: known })
        return
      }
      const current = new AbortController()
      controller = current
      timer = setTimeout(() => {
        timer = undefined
        void fetch(line, current.signal).then((text) => {
          if (current.signal.aborted || text === null) return
          cache.set(line, text)
          onResult({ line, text })
        })
      }, delayMs)
    },
    cancel,
  }
}
