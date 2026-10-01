import type {
  BoardColumn,
  CardActivity,
  CardComment,
  CardThread,
  TrellisBoard,
  TrellisCard,
  VaultEntrySummary,
} from './trellis'

export type ClaimState = 'none' | 'mine' | 'other'

export const DONE_COLUMN_LIMIT = 30
const ACTOR_ID_SHOWN = 6

export function claimState(card: TrellisCard, actor: string, nowMs: number): ClaimState {
  if (!card.claimedBy) return 'none'
  if (card.claimUntil !== undefined && card.claimUntil <= nowMs) return 'none'
  return card.claimedBy === actor ? 'mine' : 'other'
}

export function actorName(actor: string): string {
  const cut = actor.indexOf(':')
  if (cut < 0) return actor
  const kind = actor.slice(0, cut)
  const id = actor.slice(cut + 1)
  const long = /^[0-9a-f]{12,}$/i.test(id)
  return `${kind} ${long ? id.slice(0, ACTOR_ID_SHOWN) : id}`
}

export interface ShownColumn {
  name: string
  done: boolean
  total: number
  cards: TrellisCard[]
  hidden: number
}

function matches(card: TrellisCard, query: string): boolean {
  if (!query) return true
  const haystack = [card.ref, card.title, card.priority, ...card.labels].join('\n').toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
}

function shownColumn(column: BoardColumn, query: string): ShownColumn {
  const found = column.cards.filter((card) => matches(card, query))
  const ordered = column.done ? [...found].sort((a, b) => b.updatedAt - a.updatedAt) : found
  const cards = column.done ? ordered.slice(0, DONE_COLUMN_LIMIT) : ordered
  return {
    name: column.name,
    done: column.done,
    total: column.cards.length,
    cards,
    hidden: ordered.length - cards.length,
  }
}

export function shownColumns(board: TrellisBoard, query: string): ShownColumn[] {
  return board.columns.map((column) => shownColumn(column, query.trim()))
}

export function findCard(board: TrellisBoard, ref: string): TrellisCard | null {
  for (const column of board.columns) {
    const card = column.cards.find((c) => c.ref === ref)
    if (card) return card
  }
  return null
}

export function moveCard(board: TrellisBoard, ref: string, to: string): TrellisBoard {
  const card = findCard(board, ref)
  if (!card || card.column === to || !board.columns.some((c) => c.name === to)) return board
  const moved = { ...card, column: to }
  return {
    ...board,
    columns: board.columns.map((column) => {
      const rest = column.cards.filter((c) => c.ref !== ref)
      return { ...column, cards: column.name === to ? [...rest, moved] : rest }
    }),
  }
}

export type ThreadItem =
  | { kind: 'comment'; at: number; comment: CardComment }
  | { kind: 'activity'; at: number; activity: CardActivity }

export function threadItems(thread: CardThread): ThreadItem[] {
  const items: ThreadItem[] = [
    ...thread.comments.map((comment) => ({
      kind: 'comment' as const,
      at: comment.createdAt,
      comment,
    })),
    ...thread.activity
      .filter((a) => a.action !== 'labeled')
      .map((activity) => ({ kind: 'activity' as const, at: activity.at, activity })),
  ]
  return items.sort((a, b) => a.at - b.at)
}

export interface EntryGroup {
  dir: string
  entries: VaultEntrySummary[]
}

function entryDir(slug: string): string {
  const cut = slug.lastIndexOf('/')
  return cut < 0 ? '' : slug.slice(0, cut)
}

export function groupEntries(entries: VaultEntrySummary[], query: string): EntryGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const groups = new Map<string, VaultEntrySummary[]>()
  for (const entry of entries) {
    const haystack = [entry.slug, entry.title, entry.summary, entry.template, ...entry.tags]
      .join('\n')
      .toLowerCase()
    if (!words.every((word) => haystack.includes(word))) continue
    const dir = entryDir(entry.slug)
    groups.set(dir, [...(groups.get(dir) ?? []), entry])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, list]) => ({
      dir,
      entries: [...list].sort((a, b) => a.title.localeCompare(b.title)),
    }))
}
