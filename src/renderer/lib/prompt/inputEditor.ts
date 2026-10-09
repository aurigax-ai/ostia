import type { CommandBlock } from '@/stores/terminal/blocksStore'
import { resolveLinkPath } from '@shared/files/fileLinks'
import type { SpecCommand } from '@shared/terminal/completionSpec'
import type { FsEntry } from '@shared/types'
import { firstCommand, isCommandPosition } from './shellTokens'
import { type SpecItem, commandWords, specAnswer } from './specCompletion'

export function inputHistory(
  byPane: Record<string, readonly CommandBlock[] | undefined>,
  paneId: string,
  hidden: ReadonlySet<string> = new Set(),
): string[] {
  const own = [...(byPane[paneId] ?? [])].reverse()
  const others = Object.entries(byPane)
    .filter(([id]) => id !== paneId && !hidden.has(id))
    .flatMap(([, list]) => list ?? [])
    .sort((a, b) => b.startedAt - a.startedAt)
  const seen = new Set<string>()
  const out: string[] = []
  for (const block of [...own, ...others]) {
    const command = block.command.trim()
    if (!command || seen.has(command)) continue
    seen.add(command)
    out.push(command)
  }
  return out
}

export function historyMatches(history: readonly string[], prefix: string): string[] {
  if (!prefix) return [...history]
  return history.filter((entry) => entry !== prefix && entry.startsWith(prefix))
}

export function caretOnFirstLine(text: string, caret: number): boolean {
  return !text.slice(0, caret).includes('\n')
}

const SHELL_SPECIAL = /[\s'"\\$`!&;|<>(){}*?#[\]]/g

export function escapeShellWord(word: string): string {
  return word.replace(SHELL_SPECIAL, (c) => `\\${c}`)
}

function unescapeShellWord(word: string): string {
  return word.replace(/\\(.)/g, '$1')
}

export interface CompletionToken {
  start: number
  word: string
}

export function completionToken(text: string, caret: number): CompletionToken {
  let start = caret
  while (start > 0) {
    const c = text[start - 1]
    if (/\s/.test(c) && text[start - 2] !== '\\') break
    start--
  }
  return { start, word: unescapeShellWord(text.slice(start, caret)) }
}

export function splitPathWord(word: string): { dir: string; base: string } {
  const cut = word.lastIndexOf('/') + 1
  return { dir: word.slice(0, cut), base: word.slice(cut) }
}

export function completionDir(dir: string, cwd: string): string {
  return dir ? resolveLinkPath(dir, cwd) : cwd
}

export type CompletionItem = FsEntry & { description?: string }

function optionStem(base: string): string {
  return base.startsWith('--') ? '--' : base.startsWith('-') ? '-' : ''
}

export function completionScope(word: string): string {
  const { dir, base } = splitPathWord(word)
  return dir + optionStem(base)
}

export async function pathCandidates(
  text: string,
  caret: number,
  cwd: string,
  list: (path: string) => Promise<FsEntry[]>,
): Promise<CompletionItem[]> {
  const { word } = completionToken(text, caret)
  return list(completionDir(splitPathWord(word).dir, cwd))
}

export function historySuggestion(draft: string, history: readonly string[]): string {
  if (!draft.trim()) return ''
  const match = history.find((entry) => entry.length > draft.length && entry.startsWith(draft))
  return match ? match.slice(draft.length) : ''
}

export function suggestionWord(suggestion: string): string {
  return /^\s*\S+/.exec(suggestion)?.[0] ?? suggestion
}

export function recentCommands(history: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const entry of history) {
    const name = firstCommand(entry)
    if (name) seen.add(name)
  }
  return [...seen]
}

export function rankCommands(names: readonly string[], recent: readonly string[]): string[] {
  const rank = new Map(recent.map((name, i) => [name, i]))
  return [...names].sort((a, b) => {
    const ra = rank.get(a) ?? Number.POSITIVE_INFINITY
    const rb = rank.get(b) ?? Number.POSITIVE_INFINITY
    if (ra !== rb) return ra - rb
    if (a.length !== b.length) return a.length - b.length
    return a < b ? -1 : a > b ? 1 : 0
  })
}

export function commandCandidates(
  names: readonly string[],
  recent: readonly string[],
): CompletionItem[] {
  return rankCommands(names, recent).map((name) => ({ name, dir: false }))
}

function specCandidates(items: readonly SpecItem[]): CompletionItem[] {
  return items.map((item) => ({ name: item.name, dir: false, description: item.description }))
}

export interface ArgumentSources {
  spec: (command: string) => Promise<SpecCommand | null>
  list: (path: string) => Promise<FsEntry[]>
}

export async function argumentCandidates(
  text: string,
  caret: number,
  cwd: string,
  sources: ArgumentSources,
): Promise<CompletionItem[]> {
  const { start, word } = completionToken(text, caret)
  const words = commandWords(text.slice(0, start))
  const spec = words ? await sources.spec(words.command) : null
  if (words && spec) {
    const answer = specAnswer(spec, words.args, word)
    if (answer.kind === 'items') {
      const all = specAnswer(spec, words.args, optionStem(splitPathWord(word).base))
      return specCandidates(all.kind === 'items' ? all.items : answer.items)
    }
    if (answer.kind === 'paths' && answer.foldersOnly) {
      const entries = await pathCandidates(text, caret, cwd, sources.list)
      return entries.filter((e) => e.dir)
    }
  }
  return pathCandidates(text, caret, cwd, sources.list)
}

export function isCommandWord(text: string, caret: number): boolean {
  const { start, word } = completionToken(text, caret)
  return !word.includes('/') && isCommandPosition(text, start)
}

export function applyCompletionItem(
  text: string,
  caret: number,
  item: CompletionItem,
): { text: string; caret: number } {
  const { start } = completionToken(text, caret)
  const raw = text.slice(start, caret)
  const dir = raw.slice(0, raw.lastIndexOf('/') + 1)
  const insert = `${dir}${escapeShellWord(item.name)}${item.dir ? '/' : ' '}`
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length }
}
