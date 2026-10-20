import { looksLikeCorrection } from './corrections'
import { keywords, overlap } from './keywords'
import type { Signal } from './signal'

const GROUP_MIN_SIGNALS = 3
const GROUP_MIN_SESSIONS = 2
const GROUP_MIN_DAYS = 2
const GROUP_MAX_SIGNALS = 40
const TERM_CEILING_MIN = 12
const TERM_CEILING_SHARE = 0.4
const GROUP_MERGE_SHARE = 0.5
const REASK_OVERLAP = 0.5
const REASK_WINDOW_MS = 10 * 60 * 1000
const WORDS_SHOWN = 3
const MARKERS = new Set([
  '不要',
  '不用',
  '不必',
  '不能',
  '不是',
  '永遠',
  '總是',
  '一律',
  '每次',
  '說過',
  '避免',
  '不該',
  '請勿',
  '別再',
  '再次',
  '已經',
  '經說',
])

export interface Candidate {
  signals: Signal[]
  words: string[]
  topic: string[]
  scope: string
}

interface Topic {
  words: string[]
  ids: Set<string>
}

function reasked(signals: readonly Signal[], words: Map<string, Set<string>>): Set<string> {
  const marked = new Set<string>()
  const ordered = [...signals].sort((a, b) => a.at - b.at)
  ordered.forEach((later, i) => {
    if (later.session === '') return
    for (const earlier of ordered.slice(0, i)) {
      const near = earlier.session === later.session && later.at - earlier.at <= REASK_WINDOW_MS
      const similar =
        overlap(words.get(earlier.id) as Set<string>, words.get(later.id) as Set<string>) >=
        REASK_OVERLAP
      if (near && similar) {
        marked.add(earlier.id)
        marked.add(later.id)
      }
    }
  })
  return marked
}

function day(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function meetsBar(group: readonly Signal[]): boolean {
  return (
    group.length >= GROUP_MIN_SIGNALS &&
    group.length <= GROUP_MAX_SIGNALS &&
    new Set(group.map((s) => s.session || s.id)).size >= GROUP_MIN_SESSIONS &&
    new Set(group.map((s) => day(s.at))).size >= GROUP_MIN_DAYS
  )
}

function shares(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let both = 0
  for (const id of a) if (b.has(id)) both += 1
  return both / (a.size + b.size - both)
}

function topics(signals: readonly Signal[], words: Map<string, Set<string>>): Topic[] {
  const byWord = new Map<string, Set<string>>()
  for (const s of signals) {
    for (const word of words.get(s.id) as Set<string>) {
      if (!MARKERS.has(word)) byWord.set(word, (byWord.get(word) ?? new Set()).add(s.id))
    }
  }
  const byId = new Map(signals.map((s) => [s.id, s]))
  const ceiling = Math.max(TERM_CEILING_MIN, Math.floor(signals.length * TERM_CEILING_SHARE))
  const seeds = [...byWord.entries()]
    .filter(
      ([, ids]) => ids.size <= ceiling && meetsBar([...ids].map((id) => byId.get(id) as Signal)),
    )
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
  const merged: Topic[] = []
  for (const [word, ids] of seeds) {
    const home = merged.find((t) => shares(t.ids, ids) >= GROUP_MERGE_SHARE)
    if (home) {
      for (const id of ids) home.ids.add(id)
      home.words.push(word)
    } else {
      merged.push({ words: [word], ids: new Set(ids) })
    }
  }
  return merged
}

function scopeOf(group: readonly Signal[]): string {
  const projects = new Set(group.map((s) => s.project))
  const [only] = [...projects]
  if (projects.size === 1 && only) return only
  const shared = group[0].stacks.filter((stack) => group.every((s) => s.stacks.includes(stack)))
  return shared.length > 0 ? `stack:${shared[0]}` : 'global'
}

export function candidateGroups(signals: readonly Signal[]): Candidate[] {
  const words = new Map(signals.map((s) => [s.id, keywords(s.text)]))
  const again = reasked(signals, words)
  const corrections = signals.filter((s) => looksLikeCorrection(s.text) || again.has(s.id))
  const byId = new Map(corrections.map((s) => [s.id, s]))
  return topics(corrections, words)
    .map((topic) => {
      const group = [...topic.ids].map((id) => byId.get(id) as Signal).sort((a, b) => a.at - b.at)
      return {
        signals: group,
        words: topic.words.slice(0, WORDS_SHOWN),
        topic: topic.words,
        scope: scopeOf(group),
      }
    })
    .filter((c) => meetsBar(c.signals))
    .sort((a, b) => b.signals.length - a.signals.length || a.signals[0].at - b.signals[0].at)
}
