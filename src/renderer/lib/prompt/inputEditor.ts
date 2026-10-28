import { resolveLinkPath } from '@shared/files/fileLinks'
import type { FsEntry } from '@shared/files/filesApi'
import type { SpecCommand } from '@shared/terminal/completionSpec'
import type { CommandBlock } from '@/stores/terminal/blocksStore'
import { firstCommand, isCommandPosition } from './shellTokens'
import { commandWords, type SpecItem, specAnswer } from './specCompletion'

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

const DOUBLE_QUOTE_ESCAPES = '"\\$`'

export type CompletionItem = FsEntry & { description?: string }

export interface CompletionToken {
  start: number
  word: string
}

function scanWord(text: string, caret: number): CompletionToken & { quote: string | null } {
  let start = 0
  let word = ''
  let quote: string | null = null
  for (let i = 0; i < caret; i++) {
    const c = text[i]
    if (c === '\\' && quote !== "'" && i + 1 < caret) {
      const next = text[i + 1]
      if (quote === null || DOUBLE_QUOTE_ESCAPES.includes(next)) {
        word += next
        i++
      } else {
        word += c
      }
    } else if (quote !== null) {
      if (c === quote) quote = null
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (/\s/.test(c)) {
      start = i + 1
      word = ''
    } else {
      word += c
    }
  }
  return { start, word, quote }
}

export function completionToken(text: string, caret: number): CompletionToken {
  const { start, word } = scanWord(text, caret)
  return { start, word }
}

export function escapeAtCaret(text: string, caret: number, name: string): string {
  const { quote } = scanWord(text, caret)
  if (quote === "'") return name.replaceAll("'", "'\\''")
  if (quote === '"') return name.replace(/["\\$`]/g, '\\$&')
  return escapeShellWord(name)
}

export function splitPathWord(word: string): { dir: string; base: string } {
  const cut = word.lastIndexOf('/') + 1
  return { dir: word.slice(0, cut), base: word.slice(cut) }
}

const HOME_VARIABLE = /^\$(?:HOME|\{HOME\})(?=\/)/
const HOME_ITEM: CompletionItem = { name: '~', dir: true }
const DOT_FOLDER: CompletionItem = { name: '..', dir: true }

function completionDir(dir: string, cwd: string): string {
  return dir ? resolveLinkPath(dir.replace(HOME_VARIABLE, '~'), cwd) : cwd
}

function optionStem(base: string): string {
  return base.startsWith('--') ? '--' : base.startsWith('-') ? '-' : ''
}

export function completionScope(word: string): string {
  const { dir, base } = splitPathWord(word)
  return dir + optionStem(base)
}

async function pathCandidates(
  text: string,
  caret: number,
  cwd: string,
  list: (path: string) => Promise<FsEntry[]>,
): Promise<CompletionItem[]> {
  const { word } = completionToken(text, caret)
  const { dir, base } = splitPathWord(word)
  if (dir === '' && word.startsWith('~')) return []
  const entries = await list(completionDir(dir, cwd))
  return /^\.{1,2}$/.test(base) ? [DOT_FOLDER, ...entries] : entries
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

interface HistorySource {
  arguments: (before: string) => string[]
  label: string
}

export interface ArgumentSources {
  spec: (command: string) => Promise<SpecCommand | null>
  list: (path: string) => Promise<FsEntry[]>
  history?: HistorySource
}

interface ArgumentAnswer {
  items: CompletionItem[]
  paths: 'any' | 'folders' | null
}

async function specOrFolderCandidates(
  text: string,
  caret: number,
  cwd: string,
  sources: ArgumentSources,
): Promise<ArgumentAnswer> {
  const { start, word } = completionToken(text, caret)
  const words = commandWords(text.slice(0, start))
  const spec = words ? await sources.spec(words.command) : null
  if (words && spec) {
    const answer = specAnswer(spec, words.args, word)
    if (answer.kind === 'items') {
      const all = specAnswer(spec, words.args, optionStem(splitPathWord(word).base))
      return { items: specCandidates(all.kind === 'items' ? all.items : answer.items), paths: null }
    }
    if (answer.kind === 'paths') {
      const entries = await pathCandidates(text, caret, cwd, sources.list)
      return answer.foldersOnly
        ? { items: entries.filter((e) => e.dir), paths: 'folders' }
        : { items: entries, paths: 'any' }
    }
  }
  return { items: await pathCandidates(text, caret, cwd, sources.list), paths: null }
}

async function existingPath(
  argument: string,
  cwd: string,
  list: ArgumentSources['list'],
): Promise<FsEntry | null> {
  const path = resolveLinkPath(argument, cwd).replace(/(.)\/+$/, '$1')
  const cut = path.lastIndexOf('/')
  if (cut < 0) return null
  const name = path.slice(cut + 1)
  const entries = await list(path.slice(0, cut) || '/').catch(() => [])
  return entries.find((entry) => entry.name === name) ?? null
}

async function historyCandidates(
  text: string,
  caret: number,
  cwd: string,
  sources: ArgumentSources,
  answer: ArgumentAnswer,
): Promise<CompletionItem[]> {
  const history = sources.history
  if (!history) return []
  const { start, word } = completionToken(text, caret)
  const { dir } = splitPathWord(word)
  const offered = new Set(answer.items.map((item) => item.name))
  const items: CompletionItem[] = []
  for (const argument of history.arguments(text.slice(0, start))) {
    if (!argument.startsWith(dir)) continue
    const name = argument.slice(dir.length).replace(/\/+$/, '')
    if (!name || offered.has(name)) continue
    const found = answer.paths ? await existingPath(argument, cwd, sources.list) : null
    if (answer.paths && (!found || (answer.paths === 'folders' && !found.dir))) continue
    offered.add(name)
    items.push({ name, dir: found?.dir === true, description: history.label })
  }
  return items
}

export async function argumentCandidates(
  text: string,
  caret: number,
  cwd: string,
  sources: ArgumentSources,
): Promise<CompletionItem[]> {
  if (completionToken(text, caret).word === '~') return [HOME_ITEM]
  const answer = await specOrFolderCandidates(text, caret, cwd, sources)
  return [...answer.items, ...(await historyCandidates(text, caret, cwd, sources, answer))]
}

export function isCommandWord(text: string, caret: number): boolean {
  const { start, word } = completionToken(text, caret)
  return !word.includes('/') && !word.startsWith('~') && isCommandPosition(text, start)
}

export function applyCompletionItem(
  text: string,
  caret: number,
  item: CompletionItem,
): { text: string; caret: number } {
  const { start } = completionToken(text, caret)
  const raw = text.slice(start, caret)
  const dir = raw.slice(0, raw.lastIndexOf('/') + 1)
  const { quote } = scanWord(text, caret)
  const opening = quote !== null && scanWord(text, start + dir.length).quote === null ? quote : ''
  const ending = item.dir ? '/' : `${quote ?? ''} `
  const insert = `${dir}${opening}${escapeAtCaret(text, caret, item.name)}${ending}`
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length }
}
