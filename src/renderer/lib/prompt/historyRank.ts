import type { ShellHistoryEntry } from '@shared/terminal/ptyApi'
import type { CommandBlock } from '@/stores/terminal/blocksStore'
import { firstCommand } from './shellTokens'

export interface HistoryFacts {
  command: string
  count: number
  order: number
  ranThisSession: boolean
  folders: ReadonlySet<string>
  failedIn: ReadonlySet<string>
  after: ReadonlySet<string>
}

export interface RankContext {
  cwd: string | null
  previous: string | null
  commands: ReadonlySet<string> | null
}

const RECENCY_WEIGHT = 4
const NONE: ReadonlySet<string> = new Set()

interface Gathered {
  command: string
  count: number
  order: number
  ranThisSession: boolean
  folders: Set<string> | null
  failedIn: Set<string> | null
  after: Set<string> | null
}

function withValue(set: Set<string> | null, value: string): Set<string> {
  return (set ?? new Set<string>()).add(value)
}

export function sessionBlocks(
  byPane: Record<string, readonly CommandBlock[] | undefined>,
  paneId: string,
  hidden: ReadonlySet<string> = new Set(),
): CommandBlock[][] {
  const others = Object.entries(byPane)
    .filter(([id]) => id !== paneId && !hidden.has(id))
    .map(([, list]) => [...(list ?? [])])
    .sort((a, b) => (a.at(-1)?.startedAt ?? 0) - (b.at(-1)?.startedAt ?? 0))
  return [...others, [...(byPane[paneId] ?? [])]]
}

export function historyFacts(
  file: readonly ShellHistoryEntry[],
  session: readonly (readonly CommandBlock[])[],
): HistoryFacts[] {
  const gathered = new Map<string, Gathered>()
  let order = 0
  const seen = (command: string, previous: string | null): Gathered => {
    let facts = gathered.get(command)
    if (!facts) {
      facts = {
        command,
        count: 0,
        order,
        ranThisSession: false,
        folders: null,
        failedIn: null,
        after: null,
      }
      gathered.set(command, facts)
    }
    facts.count++
    facts.order = order++
    if (previous) facts.after = withValue(facts.after, previous)
    return facts
  }
  let previous: string | null = null
  for (const entry of file) {
    const command = entry.command.trim()
    if (!command) continue
    seen(command, previous)
    previous = command
  }
  for (const blocks of session) {
    previous = null
    for (const block of blocks) {
      const command = block.command.trim()
      if (!command) continue
      const facts = seen(command, previous)
      previous = command
      facts.ranThisSession = true
      if (!block.cwd) continue
      facts.folders = withValue(facts.folders, block.cwd)
      if (block.exitCode === null) continue
      if (block.exitCode === 0) facts.failedIn?.delete(block.cwd)
      else facts.failedIn = withValue(facts.failedIn, block.cwd)
    }
  }
  return [...gathered.values()].map((facts) => ({
    command: facts.command,
    count: facts.count,
    order: facts.order,
    ranThisSession: facts.ranThisSession,
    folders: facts.folders ?? NONE,
    failedIn: facts.failedIn ?? NONE,
    after: facts.after ?? NONE,
  }))
}

function shellStillHas(entry: HistoryFacts, commands: ReadonlySet<string> | null): boolean {
  if (!commands || entry.ranThisSession) return true
  const name = firstCommand(entry.command)
  return !name || name.includes('/') || commands.has(name)
}

export function rankHistory(
  draft: string,
  entries: readonly HistoryFacts[],
  context: RankContext,
): HistoryFacts[] {
  const { cwd, previous, commands } = context
  const newest = entries.reduce((max, entry) => Math.max(max, entry.order), 0) + 1
  const frecency = (entry: HistoryFacts): number =>
    Math.log2(1 + entry.count) + (RECENCY_WEIGHT * (entry.order + 1)) / newest
  const tiers = (entry: HistoryFacts): number[] => [
    cwd !== null && entry.failedIn.has(cwd) ? 0 : 1,
    cwd !== null && entry.folders.has(cwd) ? 1 : 0,
    previous !== null && entry.after.has(previous) ? 1 : 0,
    frecency(entry),
  ]
  return entries
    .filter(
      (entry) =>
        entry.command.length > draft.length &&
        entry.command.startsWith(draft) &&
        shellStillHas(entry, commands),
    )
    .map((entry) => ({ entry, tiers: tiers(entry) }))
    .sort((a, b) => {
      for (let i = 0; i < a.tiers.length; i++) {
        if (a.tiers[i] !== b.tiers[i]) return b.tiers[i] - a.tiers[i]
      }
      return 0
    })
    .map(({ entry }) => entry)
}

export function rankedSuggestion(
  draft: string,
  entries: readonly HistoryFacts[],
  context: RankContext,
): string {
  if (!draft.trim()) return ''
  const best = rankHistory(draft, entries, context)[0]
  return best ? best.command.slice(draft.length) : ''
}

export function fileOnlyCommands(
  file: readonly ShellHistoryEntry[],
  session: readonly string[],
): string[] {
  const seen = new Set(session)
  const out: string[] = []
  for (let i = file.length - 1; i >= 0; i--) {
    const command = file[i].command.trim()
    if (!command || seen.has(command)) continue
    seen.add(command)
    out.push(command)
  }
  return out
}
