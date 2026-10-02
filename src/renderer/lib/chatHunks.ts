import { diffLines } from 'diff'

export type HunkDecision = 'accepted' | 'rejected'

export type HunkDecisions = readonly (HunkDecision | null | undefined)[]

export interface EditHunk {
  index: number
  oldStart: number
  removed: string[]
  added: string[]
  leading: string[]
  trailing: string[]
}

type Piece = { kind: 'same'; text: string } | { kind: 'change'; removed: string; added: string }

const CONTEXT_LINES = 3

function linesOf(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((line) => line.replace(/\r$/, ''))
}

function pieces(before: string, after: string): Piece[] {
  const out: Piece[] = []
  for (const change of diffLines(before, after)) {
    if (!change.added && !change.removed) {
      out.push({ kind: 'same', text: change.value })
      continue
    }
    const last = out[out.length - 1]
    const open = last?.kind === 'change' ? last : null
    const target = open ?? { kind: 'change' as const, removed: '', added: '' }
    if (change.removed) target.removed += change.value
    else target.added += change.value
    if (!open) out.push(target)
  }
  return out
}

export function editHunks(before: string, after: string): EditHunk[] {
  const list = pieces(before, after)
  const hunks: EditHunk[] = []
  let line = 1
  list.forEach((piece, at) => {
    if (piece.kind === 'same') {
      line += linesOf(piece.text).length
      return
    }
    const prev = list[at - 1]
    const next = list[at + 1]
    hunks.push({
      index: hunks.length,
      oldStart: line,
      removed: linesOf(piece.removed),
      added: linesOf(piece.added),
      leading: prev?.kind === 'same' ? linesOf(prev.text).slice(-CONTEXT_LINES) : [],
      trailing: next?.kind === 'same' ? linesOf(next.text).slice(0, CONTEXT_LINES) : [],
    })
    line += linesOf(piece.removed).length
  })
  return hunks
}

export function contentWith(before: string, after: string, decisions: HunkDecisions): string {
  let hunk = 0
  return pieces(before, after)
    .map((piece) => {
      if (piece.kind === 'same') return piece.text
      const decision = decisions[hunk]
      hunk += 1
      return decision === 'rejected' ? piece.removed : piece.added
    })
    .join('')
}

export function hunkCounts(hunks: readonly EditHunk[], decisions: HunkDecisions) {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    if (decisions[hunk.index] === 'rejected') continue
    added += hunk.added.length
    removed += hunk.removed.length
  }
  return { added, removed }
}

export function allDecided(count: number, decisions: HunkDecisions): boolean {
  for (let i = 0; i < count; i++) if (!decisions[i]) return false
  return true
}

export function settle(count: number, decisions: HunkDecisions): HunkDecision[] {
  return Array.from({ length: count }, (_, i) => decisions[i] ?? 'accepted')
}
