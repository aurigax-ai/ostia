import { ipcMain } from 'electron'
import type {
  HistoryBlockRange,
  HistoryPage,
  HistorySearchOptions,
  HistorySearchResult,
} from '../../../shared/terminal/scrollbackHistory'
import type { PtyEntry } from '../pty/ptyRegistry'
import { outputText, sameCommand, searchHistory } from './historySearch'
import type { PaneHistories } from './paneHistories'
import type { PaneHistory } from './paneHistory'

const PAGE_LINES_MAX = 5000
const PAGE_CHARS_MAX = 4 * 1024 * 1024
const LINE_CHARS_MAX = 16_384
const BLOCK_OUTPUT_CHARS_MAX = 16 * 1024 * 1024

interface HistoryIpcDeps {
  ptys: Map<string, PtyEntry>
  windowOfPane: (paneId: string) => string | undefined
  services: { histories: PaneHistories | null }
}

function clipLine(line: string): string {
  return line.length > LINE_CHARS_MAX ? `${line.slice(0, LINE_CHARS_MAX)}\x1b[0m…` : line
}

function wholeNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : fallback
}

function searchOptions(raw: unknown): HistorySearchOptions {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    caseSensitive: source.caseSensitive === true,
    regex: source.regex === true,
    wholeWord: source.wholeWord === true,
  }
}

export function registerHistoryIpc({ ptys, windowOfPane, services }: HistoryIpcDeps): void {
  const ownHistory = (e: Electron.IpcMainInvokeEvent, paneId: unknown): PaneHistory | null => {
    if (typeof paneId !== 'string') return null
    if (windowOfPane(paneId) !== String(e.sender.id)) return null
    return services.histories?.get(paneId) ?? null
  }

  const withTail = async (
    paneId: string,
    history: PaneHistory,
  ): Promise<{ tail: string[]; tailStart: number }> => {
    const tail = (await ptys.get(paneId)?.mirror.historyTail()) ?? []
    return { tail, tailStart: history.end }
  }

  const readLines = async (
    history: PaneHistory,
    tail: { tail: string[]; tailStart: number },
    from: number,
    stop: number,
  ): Promise<string[]> => {
    const stored = await history.read(from, Math.min(stop, tail.tailStart) - from)
    const fromTail = tail.tail.slice(Math.max(0, from - tail.tailStart), stop - tail.tailStart)
    return [...stored, ...fromTail]
  }

  ipcMain.handle(
    'pty:history-read',
    async (
      e,
      paneId: unknown,
      rawFrom: unknown,
      rawCount: unknown,
    ): Promise<HistoryPage | null> => {
      const history = ownHistory(e, paneId)
      if (!history) return null
      const tail = await withTail(paneId as string, history)
      const end = tail.tailStart + tail.tail.length
      const from = Math.min(end, Math.max(history.first, wholeNumber(rawFrom, history.first)))
      const count = Math.min(PAGE_LINES_MAX, wholeNumber(rawCount, 0))
      const all = await readLines(history, tail, from, Math.min(end, from + count))
      const lines: string[] = []
      let chars = 0
      for (const line of all) {
        const clipped = clipLine(line)
        chars += clipped.length
        if (chars > PAGE_CHARS_MAX && lines.length > 0) break
        lines.push(clipped)
      }
      return { first: history.first, end, from, lines }
    },
  )

  const searches = new Map<string, number>()
  ipcMain.handle(
    'pty:history-search',
    async (
      e,
      paneId: unknown,
      query: unknown,
      rawOptions: unknown,
      rawLiveLines: unknown,
    ): Promise<HistorySearchResult | null> => {
      const history = ownHistory(e, paneId)
      if (!history || typeof query !== 'string') return null
      const key = `${e.sender.id}\0${paneId as string}`
      const generation = (searches.get(key) ?? 0) + 1
      searches.set(key, generation)
      const tail = await withTail(paneId as string, history)
      const until = tail.tailStart + tail.tail.length - wholeNumber(rawLiveLines, 0)
      const result = await searchHistory(
        history,
        query,
        searchOptions(rawOptions),
        Math.min(until, tail.tailStart),
        () => searches.get(key) !== generation,
      )
      if (searches.get(key) === generation) searches.delete(key)
      return result
    },
  )

  const blockOf = async (paneId: string, history: PaneHistory, seq: unknown, command: unknown) => {
    if (typeof seq !== 'number' || typeof command !== 'string') return undefined
    await withTail(paneId, history)
    const block = history.block(seq)
    if (!block || !sameCommand(block.command, command)) return undefined
    if (block.end !== null) return { ...block, end: block.end }
    const pending = await ptys.get(paneId)?.mirror.pendingBlockEnd(seq)
    return { ...block, end: pending?.line ?? null, endCol: pending?.endCol ?? 0 }
  }

  ipcMain.handle(
    'pty:history-block',
    async (
      e,
      paneId: unknown,
      seq: unknown,
      command: unknown,
    ): Promise<HistoryBlockRange | null> => {
      const history = ownHistory(e, paneId)
      const block = history ? await blockOf(paneId as string, history, seq, command) : undefined
      if (!history || !block) return null
      return { start: block.start, end: block.end ?? history.end }
    },
  )

  ipcMain.handle(
    'pty:block-output',
    async (e, paneId: unknown, seq: unknown, command: unknown): Promise<string | null> => {
      const history = ownHistory(e, paneId)
      const block = history ? await blockOf(paneId as string, history, seq, command) : undefined
      if (!history || !block) return null
      const tail = await withTail(paneId as string, history)
      const end = tail.tailStart + tail.tail.length
      const stop = block.end === null ? end : Math.min(end, block.end + 1)
      const lines = await readLines(history, tail, block.start, stop)
      const text = outputText(lines, block.end === null ? null : block.endCol)
      return text.length > BLOCK_OUTPUT_CHARS_MAX ? text.slice(-BLOCK_OUTPUT_CHARS_MAX) : text
    },
  )
}
