import type { SpecArg, SpecCommand, SpecOption } from '@shared/terminal/completionSpec'
import { tokenizeShell } from './shellTokens'

export type SpecItemKind = 'subcommand' | 'option' | 'value'

export interface SpecItem {
  name: string
  description?: string
  kind: SpecItemKind
}

export type SpecAnswer =
  | { kind: 'items'; items: SpecItem[] }
  | { kind: 'paths'; foldersOnly: boolean }
  | { kind: 'none' }

export interface CommandWords {
  command: string
  args: string[]
}

const unquote = (word: string): string =>
  word.replace(/\\(.)|'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_m, esc, single, double) =>
    esc !== undefined ? esc : single !== undefined ? single : double.replace(/\\(.)/g, '$1'),
  )

export function commandWords(before: string): CommandWords | null {
  const words: string[] = []
  let current = ''
  let started = false
  for (const token of tokenizeShell(before)) {
    if (token.kind === 'operator') {
      words.length = 0
      current = ''
      started = false
      continue
    }
    if (token.kind === 'comment') return null
    if (token.kind === 'space') {
      if (current) words.push(current)
      current = ''
      continue
    }
    if (token.kind === 'command') started = true
    if (!started) continue
    current += token.text
  }
  if (current) words.push(current)
  if (words.length === 0) return null
  const [command, ...args] = words.map(unquote)
  return { command, args }
}

function findOption(options: readonly SpecOption[], flag: string): SpecOption | undefined {
  return options.find((o) => o.names.includes(flag))
}

function argAt(args: readonly SpecArg[] | undefined, index: number): SpecArg | undefined {
  if (!args || args.length === 0) return undefined
  if (index < args.length) return args[index]
  const last = args[args.length - 1]
  return last.isVariadic ? last : undefined
}

function argAnswer(arg: SpecArg, current: string, extra: SpecItem[] = []): SpecAnswer {
  const values: SpecItem[] = (arg.suggestions ?? [])
    .filter((s) => s.name.startsWith(current))
    .map((s) => ({ name: s.name, description: s.description, kind: 'value' }))
  const items = [...extra, ...values]
  if (items.length > 0) return { kind: 'items', items }
  if (arg.template) return { kind: 'paths', foldersOnly: !arg.template.includes('filepaths') }
  return { kind: 'none' }
}

function optionItems(
  options: readonly SpecOption[],
  used: Set<string>,
  current: string,
): SpecItem[] {
  const long = current.startsWith('--')
  const items: SpecItem[] = []
  for (const option of options) {
    if (!option.isRepeatable && option.names.some((n) => used.has(n))) continue
    const matching = option.names.filter((n) => n.startsWith(current))
    if (matching.length === 0) continue
    const name = matching.find((n) => n.startsWith('--') === long) ?? matching[0]
    items.push({ name, description: option.description, kind: 'option' })
  }
  return items
}

function markShortFlags(options: readonly SpecOption[], word: string, used: Set<string>): void {
  if (word.startsWith('--') || word.length <= 2) return
  for (const char of word.slice(1)) {
    const option = findOption(options, `-${char}`)
    if (option) for (const n of option.names) used.add(n)
  }
}

export function specAnswer(
  spec: SpecCommand,
  args: readonly string[],
  current: string,
): SpecAnswer {
  let node = spec
  let persistent: SpecOption[] = []
  let pending: SpecArg[] = []
  let positional = 0
  let afterDoubleDash = false
  const used = new Set<string>()
  const options = (): SpecOption[] => [...(node.options ?? []), ...persistent]

  for (const word of args) {
    if (pending.length > 0) {
      pending = pending.slice(1)
      continue
    }
    if (!afterDoubleDash && word === '--') {
      afterDoubleDash = true
      continue
    }
    if (!afterDoubleDash && word.startsWith('-') && word.length > 1) {
      const eq = word.indexOf('=')
      const flag = eq === -1 ? word : word.slice(0, eq)
      const option = findOption(options(), flag)
      if (option) {
        for (const n of option.names) used.add(n)
        if (eq === -1) pending = (option.args ?? []).filter((a) => !a.isOptional)
      } else {
        markShortFlags(options(), word, used)
      }
      continue
    }
    const sub =
      positional === 0 && !afterDoubleDash
        ? node.subcommands?.find((c) => c.names.includes(word))
        : undefined
    if (sub) {
      persistent = [...persistent, ...(node.options ?? []).filter((o) => o.isPersistent)]
      node = sub
      used.clear()
      continue
    }
    positional++
  }

  if (pending.length > 0) return argAnswer(pending[0], current)
  if (!afterDoubleDash && current.startsWith('-')) {
    const items = optionItems(options(), used, current)
    return items.length > 0 ? { kind: 'items', items } : { kind: 'none' }
  }
  const subcommands: SpecItem[] =
    positional === 0 && !afterDoubleDash
      ? (node.subcommands ?? []).flatMap((c) => {
          const name = c.names.find((n) => n.startsWith(current))
          return name ? [{ name, description: c.description, kind: 'subcommand' as const }] : []
        })
      : []
  const arg = argAt(node.args, positional)
  if (arg) return argAnswer(arg, current, subcommands)
  return subcommands.length > 0 ? { kind: 'items', items: subcommands } : { kind: 'none' }
}
