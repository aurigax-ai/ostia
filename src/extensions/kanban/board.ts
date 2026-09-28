import { loadJson, projectStorePath, saveJson } from '../sdk'

export interface KanbanCard {
  id: string
  title: string
  column: string
  assignee?: string
  body?: string
  createdAt: string
  updatedAt: string
}

export interface KanbanColumn {
  id: string
  name: string
}

export interface KanbanBoard {
  columns: KanbanColumn[]
  cards: KanbanCard[]
}

export type CardPatch = Partial<Pick<KanbanCard, 'title' | 'body' | 'column' | 'assignee'>>

export type BoardError = { ok: false; error: string; message?: string }

export const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: 'todo', name: 'Todo' },
  { id: 'doing', name: 'Doing' },
  { id: 'done', name: 'Done' },
]

export const MAX_FIELD_BYTES = 64 * 1024
export const MAX_CARDS = 2000

const NOT_FOUND: BoardError = { ok: false, error: 'not-found' }
const UNKNOWN_COLUMN: BoardError = { ok: false, error: 'unknown-column' }
const TOO_LARGE: BoardError = { ok: false, error: 'too-large' }
const TOO_MANY_CARDS: BoardError = {
  ok: false,
  error: 'too-many-cards',
  message: `this board already has ${MAX_CARDS} cards — remove one before adding another`,
}

export function boardPath(workDir: string): string {
  return projectStorePath('board', workDir)
}

export function loadBoard(path: string): KanbanBoard {
  return loadJson<KanbanBoard>(path, { columns: DEFAULT_COLUMNS, cards: [] })
}

function tooLarge(s: string | undefined): boolean {
  return s !== undefined && Buffer.byteLength(s, 'utf8') > MAX_FIELD_BYTES
}

function nextCardId(board: KanbanBoard): string {
  let max = 0
  for (const card of board.cards) {
    const m = /^card-(\d+)$/.exec(card.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `card-${max + 1}`
}

export function addCard(
  path: string,
  input: { title: string; column?: string; body?: string },
): { card: KanbanCard } | BoardError {
  if (!input.title) return { ok: false, error: 'missing-title' }
  if (tooLarge(input.title) || tooLarge(input.body)) return TOO_LARGE
  const board = loadBoard(path)
  if (board.cards.length >= MAX_CARDS) return TOO_MANY_CARDS
  const column = input.column ?? 'todo'
  if (!board.columns.some((c) => c.id === column)) return UNKNOWN_COLUMN
  const now = new Date().toISOString()
  const card: KanbanCard = {
    id: nextCardId(board),
    title: input.title,
    column,
    body: input.body,
    createdAt: now,
    updatedAt: now,
  }
  board.cards.push(card)
  saveJson(path, board)
  return { card }
}

export function updateCard(
  path: string,
  cardId: string,
  patch: CardPatch,
): { ok: true } | BoardError {
  if (tooLarge(patch.title) || tooLarge(patch.body)) return TOO_LARGE
  const board = loadBoard(path)
  const card = board.cards.find((c) => c.id === cardId)
  if (!card) return NOT_FOUND
  if (patch.column !== undefined && !board.columns.some((c) => c.id === patch.column)) {
    return UNKNOWN_COLUMN
  }
  if (patch.title !== undefined) card.title = patch.title
  if (patch.body !== undefined) card.body = patch.body
  if (patch.column !== undefined) card.column = patch.column
  if (patch.assignee !== undefined) card.assignee = patch.assignee
  card.updatedAt = new Date().toISOString()
  saveJson(path, board)
  return { ok: true }
}

export function removeCard(path: string, cardId: string): { ok: true } | BoardError {
  const board = loadBoard(path)
  const idx = board.cards.findIndex((c) => c.id === cardId)
  if (idx === -1) return NOT_FOUND
  board.cards.splice(idx, 1)
  saveJson(path, board)
  return { ok: true }
}

export function sanitizePatch(raw: unknown): CardPatch {
  const patch: CardPatch = {}
  if (typeof raw !== 'object' || raw === null) return patch
  for (const key of ['title', 'body', 'column', 'assignee'] as const) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value === 'string') patch[key] = value
  }
  return patch
}

export function formatBoard(board: KanbanBoard): string {
  const lines: string[] = []
  for (const col of board.columns) {
    const cards = board.cards.filter((c) => c.column === col.id)
    lines.push(`# ${col.name} (${col.id})`)
    if (cards.length === 0) lines.push('  (empty)')
    for (const c of cards) lines.push(`  ${c.id}\t${c.title}${c.assignee ? ` @${c.assignee}` : ''}`)
  }
  return lines.join('\n')
}
