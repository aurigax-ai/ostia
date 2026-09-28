import { ipcMain } from 'electron'
import type {
  KanbanBoard,
  KanbanCard,
  KanbanColumn,
  KanbanMutateOp,
  KanbanMutateResult,
} from '../shared/types'
import { registerControlMethod } from './controlServer'
import { loadJson, saveJson, storePath } from './jsonStore'
import { workDirForSession } from './sessionRegistry'

export type { KanbanBoard, KanbanCard, KanbanColumn } from '../shared/types'

const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: 'todo', name: 'Todo' },
  { id: 'doing', name: 'Doing' },
  { id: 'done', name: 'Done' },
]

export interface NoProjectWorkDir {
  ok: false
  error: 'no-project-workdir'
  message: string
}

function noProjectWorkDir(): NoProjectWorkDir {
  return {
    ok: false,
    error: 'no-project-workdir',
    message:
      'no project workDir is known for this session yet, so a project-scoped board would ' +
      "collapse into a shared default — retry once the pane's project is resolved.",
  }
}

function boardPathForWorkDir(workDir: string): string {
  return storePath('board', 'project', workDir)
}

function boardPath(sessionId: string): string | NoProjectWorkDir {
  const workDir = workDirForSession(sessionId)
  if (!workDir) return noProjectWorkDir()
  return boardPathForWorkDir(workDir)
}

function loadBoard(path: string): KanbanBoard {
  return loadJson<KanbanBoard>(path, { columns: DEFAULT_COLUMNS, cards: [] })
}

function saveBoard(path: string, board: KanbanBoard): void {
  saveJson(path, board)
}

const NOT_FOUND = { ok: false, error: 'not-found' as const }
const UNKNOWN_COLUMN = { ok: false, error: 'unknown-column' as const }
const TOO_LARGE = { ok: false, error: 'too-large' as const }

const MAX_FIELD_BYTES = 64 * 1024
const MAX_CARDS = 2000
const TOO_MANY_CARDS = {
  ok: false,
  error: 'too-many-cards' as const,
  message: `this board already has ${MAX_CARDS} cards — remove one before adding another`,
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

export function kanbanGet(sessionId: string): KanbanBoard | NoProjectWorkDir {
  const path = boardPath(sessionId)
  if (typeof path !== 'string') return path
  return loadBoard(path)
}

export type KanbanUpdateResult =
  | { ok: true }
  | typeof NOT_FOUND
  | typeof UNKNOWN_COLUMN
  | typeof TOO_LARGE
  | NoProjectWorkDir

function addCardAt(
  path: string,
  params: { title: string; column?: string; body?: string },
): { card: KanbanCard } | typeof UNKNOWN_COLUMN | typeof TOO_LARGE | typeof TOO_MANY_CARDS {
  const { title, column, body } = params
  if (tooLarge(title) || tooLarge(body)) return TOO_LARGE
  const board = loadBoard(path)
  if (board.cards.length >= MAX_CARDS) return TOO_MANY_CARDS
  const targetColumn = column ?? 'todo'
  if (!board.columns.some((c) => c.id === targetColumn)) return UNKNOWN_COLUMN
  const now = new Date().toISOString()
  const card: KanbanCard = {
    id: nextCardId(board),
    title,
    column: targetColumn,
    body,
    createdAt: now,
    updatedAt: now,
  }
  board.cards.push(card)
  saveBoard(path, board)
  return { card }
}

function moveCardAt(
  path: string,
  params: { cardId: string; column: string },
): { ok: true } | typeof NOT_FOUND | typeof UNKNOWN_COLUMN {
  const { cardId, column } = params
  const board = loadBoard(path)
  const card = board.cards.find((c) => c.id === cardId)
  if (!card) return NOT_FOUND
  if (!board.columns.some((c) => c.id === column)) return UNKNOWN_COLUMN
  card.column = column
  card.updatedAt = new Date().toISOString()
  saveBoard(path, board)
  return { ok: true }
}

function updateCardAt(
  path: string,
  cardId: string,
  patch: Partial<Pick<KanbanCard, 'title' | 'body' | 'column' | 'assignee'>>,
): { ok: true } | typeof NOT_FOUND | typeof UNKNOWN_COLUMN | typeof TOO_LARGE {
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
  saveBoard(path, board)
  return { ok: true }
}

function removeCardAt(path: string, params: { cardId: string }): { ok: true } | typeof NOT_FOUND {
  const board = loadBoard(path)
  const idx = board.cards.findIndex((c) => c.id === params.cardId)
  if (idx === -1) return NOT_FOUND
  board.cards.splice(idx, 1)
  saveBoard(path, board)
  return { ok: true }
}

export function kanbanUpdate(
  sessionId: string,
  cardId: string,
  patch: Partial<Pick<KanbanCard, 'title' | 'body' | 'column' | 'assignee'>>,
): KanbanUpdateResult {
  const path = boardPath(sessionId)
  if (typeof path !== 'string') return path
  return updateCardAt(path, cardId, patch)
}

function isKanbanFailure(r: unknown): r is { ok: false; error: string; message?: string } {
  return typeof r === 'object' && r !== null && (r as { ok?: unknown }).ok === false
}

type KanbanOpResult =
  | { card: KanbanCard }
  | { ok: true }
  | typeof NOT_FOUND
  | typeof UNKNOWN_COLUMN
  | typeof TOO_LARGE
  | typeof TOO_MANY_CARDS

function applyMutation(path: string, op: KanbanMutateOp): KanbanOpResult {
  switch (op.op) {
    case 'add':
      return addCardAt(path, op)
    case 'move':
      return moveCardAt(path, op)
    case 'update':
      return updateCardAt(path, op.cardId, op.patch)
    case 'remove':
      return removeCardAt(path, op)
  }
}

export function kanbanGetForWorkDir(workDir: string): KanbanBoard | NoProjectWorkDir {
  if (!workDir?.trim()) return noProjectWorkDir()
  return loadBoard(boardPathForWorkDir(workDir))
}

export function kanbanMutateForWorkDir(workDir: string, op: KanbanMutateOp): KanbanMutateResult {
  if (!workDir?.trim()) return noProjectWorkDir()
  const path = boardPathForWorkDir(workDir)
  const result = applyMutation(path, op)
  if (isKanbanFailure(result)) return result
  return { ok: true, board: loadBoard(path) }
}

export function registerKanbanIpc(): void {
  ipcMain.handle('kanban:get', (_e, params: { workDir: string }) =>
    kanbanGetForWorkDir(params?.workDir),
  )
  ipcMain.handle('kanban:mutate', (_e, params: { workDir: string; op: KanbanMutateOp }) =>
    kanbanMutateForWorkDir(params?.workDir, params?.op),
  )
}

export function registerKanbanMethods(): void {
  registerControlMethod('kanban.get', {
    cap: 'read-board',
    handler: (_params, ctx) => kanbanGet(ctx.identity.sessionId),
  })

  registerControlMethod('kanban.add', {
    cap: 'board-write',
    handler: (params, ctx) => {
      const path = boardPath(ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      const { title, column, body } = (params ?? {}) as {
        title: string
        column?: string
        body?: string
      }
      return addCardAt(path, { title, column, body })
    },
  })

  registerControlMethod('kanban.move', {
    cap: 'board-write',
    handler: (params, ctx) => {
      const path = boardPath(ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      const { cardId, column } = (params ?? {}) as { cardId: string; column: string }
      return moveCardAt(path, { cardId, column })
    },
  })

  registerControlMethod('kanban.assign', {
    cap: 'board-write',
    handler: (params, ctx) => {
      const path = boardPath(ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      const { cardId, assignee } = (params ?? {}) as { cardId: string; assignee: string }
      const board = loadBoard(path)
      const card = board.cards.find((c) => c.id === cardId)
      if (!card) return NOT_FOUND
      card.assignee = assignee
      card.updatedAt = new Date().toISOString()
      saveBoard(path, board)
      return { ok: true }
    },
  })

  registerControlMethod('kanban.update', {
    cap: 'board-write',
    handler: (params, ctx) => {
      const { cardId, patch } = (params ?? {}) as {
        cardId: string
        patch: Partial<Pick<KanbanCard, 'title' | 'body' | 'column' | 'assignee'>>
      }
      return kanbanUpdate(ctx.identity.sessionId, cardId, patch)
    },
  })

  registerControlMethod('kanban.remove', {
    cap: 'board-write',
    handler: (params, ctx) => {
      const path = boardPath(ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      const { cardId } = (params ?? {}) as { cardId: string }
      return removeCardAt(path, { cardId })
    },
  })
}
