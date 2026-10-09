import { type CompletionItem, completionScope, completionToken, splitPathWord } from './inputEditor'

export type MatchTier = 'prefix' | 'prefixIgnoreCase' | 'substring' | 'fuzzy'

export interface CompletionMatch {
  item: CompletionItem
  tier: MatchTier
  marks: number[]
}

const TIER_ORDER: readonly MatchTier[] = ['prefix', 'prefixIgnoreCase', 'substring', 'fuzzy']

function foldCase(text: string): string {
  return Array.from(text, (c) => {
    const lower = c.toLowerCase()
    return lower.length === c.length ? lower : c
  }).join('')
}

function span(from: number, length: number): number[] {
  return Array.from({ length }, (_, i) => from + i)
}

function subsequence(name: string, base: string): number[] | null {
  const marks: number[] = []
  let at = 0
  for (const char of base) {
    const found = name.indexOf(char, at)
    if (found === -1) return null
    marks.push(found)
    at = found + 1
  }
  return marks
}

export function matchName(name: string, base: string): { tier: MatchTier; marks: number[] } | null {
  if (name.startsWith(base)) return { tier: 'prefix', marks: span(0, base.length) }
  const foldedName = foldCase(name)
  const foldedBase = foldCase(base)
  if (foldedName.startsWith(foldedBase)) {
    return { tier: 'prefixIgnoreCase', marks: span(0, base.length) }
  }
  const inside = foldedName.indexOf(foldedBase)
  if (inside !== -1) return { tier: 'substring', marks: span(inside, base.length) }
  const fuzzy = subsequence(foldedName, foldedBase)
  return fuzzy ? { tier: 'fuzzy', marks: fuzzy } : null
}

function hiddenFrom(name: string, base: string): boolean {
  return name.startsWith('.') && !base.startsWith('.')
}

export function filterCompletions(
  pool: readonly CompletionItem[],
  base: string,
): CompletionMatch[] {
  const tiers = new Map<MatchTier, CompletionMatch[]>(TIER_ORDER.map((tier) => [tier, []]))
  const seen = new Set<string>()
  for (const item of pool) {
    if (hiddenFrom(item.name, base) || seen.has(item.name)) continue
    const match = matchName(item.name, base)
    if (!match) continue
    seen.add(item.name)
    tiers.get(match.tier)?.push({ item, ...match })
  }
  return TIER_ORDER.flatMap((tier) => tiers.get(tier) ?? [])
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

export type TabStep =
  | { kind: 'none' }
  | { kind: 'pick'; item: CompletionItem }
  | { kind: 'menu'; extend: string; matches: CompletionMatch[] }

export function tabStep(pool: readonly CompletionItem[], base: string): TabStep {
  const matches = filterCompletions(pool, base)
  if (matches.length === 0) return { kind: 'none' }
  const exact = matches.filter((m) => m.tier === 'prefix')
  const lead = exact.length > 0 ? exact : matches.filter((m) => m.tier === 'prefixIgnoreCase')
  if (lead.length === 1) return { kind: 'pick', item: lead[0].item }
  if (matches.length === 1) return { kind: 'pick', item: matches[0].item }
  const extend = exact.length > 1 ? commonPrefix(exact.map((m) => m.item.name)) : base
  if (extend.length <= base.length) return { kind: 'menu', extend: '', matches }
  return {
    kind: 'menu',
    extend: extend.slice(base.length),
    matches: filterCompletions(pool, extend),
  }
}

export interface CompletionOrigin {
  start: number
  scope: string
  pool: CompletionItem[]
}

export type DraftStep =
  | { kind: 'close' }
  | { kind: 'relist'; scope: string }
  | { kind: 'filter'; matches: CompletionMatch[] }

export function followDraft(origin: CompletionOrigin, text: string, caret: number): DraftStep {
  const { start, word } = completionToken(text, caret)
  if (start !== origin.start) return { kind: 'close' }
  if (caret === start && /\S/.test(text[caret] ?? '')) return { kind: 'close' }
  const scope = completionScope(word)
  if (scope !== origin.scope) return { kind: 'relist', scope }
  return { kind: 'filter', matches: filterCompletions(origin.pool, splitPathWord(word).base) }
}

export function completionLabel(item: CompletionItem): string {
  return item.dir ? `${item.name}/` : item.name
}

export function keepSelection(
  before: readonly CompletionMatch[],
  index: number,
  after: readonly CompletionMatch[],
): number {
  const selected = before[index]
  if (!selected) return 0
  const label = completionLabel(selected.item)
  const kept = after.findIndex((m) => completionLabel(m.item) === label)
  return kept === -1 ? 0 : kept
}

export interface MarkRun {
  at: number
  text: string
  marked: boolean
}

export function markRuns(text: string, marks: readonly number[]): MarkRun[] {
  const set = new Set(marks)
  const runs: MarkRun[] = []
  for (let i = 0; i < text.length; i++) {
    const marked = set.has(i)
    const last = runs[runs.length - 1]
    if (last && last.marked === marked) last.text += text[i]
    else runs.push({ at: i, text: text[i], marked })
  }
  return runs
}
