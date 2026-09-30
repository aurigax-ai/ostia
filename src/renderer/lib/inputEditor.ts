import type { FsEntry } from '../../shared/types'
import type { CommandBlock } from '../stores/blocksStore'
import { resolveLinkPath } from './fileLinks'

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

export interface Completion {
  insert: string
  candidates: FsEntry[]
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
