import type { SpecCommand } from '../../shared/completionSpec'
import type { FsEntry } from '../../shared/types'
import type { CommandBlock } from '../stores/blocksStore'
import { resolveLinkPath } from './fileLinks'
import { firstCommand, isCommandPosition } from './shellTokens'
import { type SpecItem, commandWords, specAnswer } from './specCompletion'

export function inputHistory(
  byPane: Record<string, readonly CommandBlock[] | undefined>,
  paneId: string,
): string[] {
  const own = [...(byPane[paneId] ?? [])].reverse()
  const others = Object.entries(byPane)
    .filter(([id]) => id !== paneId)
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

export interface Completion {
  insert: string
  candidates: CompletionItem[]
}

function commonPrefix(names: readonly string[]): string {
  if (names.length === 0) return ''
  let prefix = names[0]
  for (const name of names.slice(1)) {
    let i = 0
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++
    prefix = prefix.slice(0, i)
  }
  return prefix
}

export function completeName(entries: readonly FsEntry[], base: string): Completion {
  const matches = entries.filter(
    (e) => e.name.startsWith(base) && (base.startsWith('.') || !e.name.startsWith('.')),
  )
  if (matches.length === 0) return { insert: '', candidates: [] }
  if (matches.length === 1) {
    const [only] = matches
    const rest = escapeShellWord(only.name.slice(base.length))
    return { insert: `${rest}${only.dir ? '/' : ' '}`, candidates: [] }
  }
  const prefix = commonPrefix(matches.map((e) => e.name))
  return { insert: escapeShellWord(prefix.slice(base.length)), candidates: matches }
}

export async function completePath(
  text: string,
  caret: number,
  cwd: string,
  list: (path: string) => Promise<FsEntry[]>,
): Promise<Completion> {
  const { word } = completionToken(text, caret)
  const { dir, base } = splitPathWord(word)
  return completeName(await list(completionDir(dir, cwd)), base)
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

export function rankCommands(
  names: readonly string[],
  prefix: string,
  recent: readonly string[],
): string[] {
  const rank = new Map(recent.map((name, i) => [name, i]))
  return names
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) => {
      const ra = rank.get(a) ?? Number.POSITIVE_INFINITY
      const rb = rank.get(b) ?? Number.POSITIVE_INFINITY
      if (ra !== rb) return ra - rb
      if (a.length !== b.length) return a.length - b.length
      return a < b ? -1 : a > b ? 1 : 0
    })
}

export function completeCommand(
  names: readonly string[],
  word: string,
  recent: readonly string[],
): Completion {
  const matches = rankCommands(names, word, recent)
  if (matches.length === 0) return { insert: '', candidates: [] }
  if (matches.length === 1) {
    return { insert: `${escapeShellWord(matches[0].slice(word.length))} `, candidates: [] }
  }
  const prefix = commonPrefix(matches)
  return {
    insert: escapeShellWord(prefix.slice(word.length)),
    candidates: matches.map((name) => ({ name, dir: false })),
  }
}

export function completeItems(items: readonly SpecItem[], word: string): Completion {
  const seen = new Set<string>()
  const unique = items.filter((item) => !seen.has(item.name) && seen.add(item.name))
  if (unique.length === 0) return { insert: '', candidates: [] }
  if (unique.length === 1) {
    return { insert: `${escapeShellWord(unique[0].name.slice(word.length))} `, candidates: [] }
  }
  const prefix = commonPrefix(unique.map((item) => item.name))
  return {
    insert: escapeShellWord(prefix.slice(word.length)),
    candidates: unique.map((item) => ({
      name: item.name,
      dir: false,
      description: item.description,
    })),
  }
}

export interface ArgumentSources {
  spec: (command: string) => Promise<SpecCommand | null>
  list: (path: string) => Promise<FsEntry[]>
}

export async function completeArgument(
  text: string,
  caret: number,
  cwd: string,
  sources: ArgumentSources,
): Promise<Completion> {
  const { start, word } = completionToken(text, caret)
  const words = commandWords(text.slice(0, start))
  const spec = words ? await sources.spec(words.command) : null
  if (words && spec) {
    const answer = specAnswer(spec, words.args, word)
    if (answer.kind === 'items') return completeItems(answer.items, word)
    if (answer.kind === 'paths' && answer.foldersOnly) {
      const { dir, base } = splitPathWord(word)
      const entries = await sources.list(completionDir(dir, cwd))
      return completeName(
        entries.filter((e) => e.dir),
        base,
      )
    }
  }
  return completePath(text, caret, cwd, sources.list)
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
