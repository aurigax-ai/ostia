import type { HistoryFacts } from './historyRank'
import { type CommandWords, commandWords } from './specCompletion'

export const HISTORY_ARGUMENTS_MAX = 8

function nextArgument(entry: string, typed: CommandWords): string | null {
  const words = commandWords(entry)
  if (!words || words.command !== typed.command) return null
  if (words.args.length <= typed.args.length) return null
  if (typed.args.some((arg, i) => words.args[i] !== arg)) return null
  return words.args[typed.args.length]
}

export function historyArguments(
  before: string,
  entries: readonly HistoryFacts[],
  max = HISTORY_ARGUMENTS_MAX,
): string[] {
  const typed = commandWords(before)
  if (!typed) return []
  const lead = `${typed.command} `
  const found = new Set<string>()
  for (const entry of [...entries].sort((a, b) => b.order - a.order)) {
    if (found.size >= max) break
    if (!entry.command.includes(lead)) continue
    const argument = nextArgument(entry.command, typed)
    if (argument && !argument.startsWith('-')) found.add(argument)
  }
  return [...found]
}
