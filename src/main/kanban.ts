/**
 * `kanban` toolbelt service (agent-toolbelt #9, capabilities 'read-board' (default) /
 * 'board-write' (elevated) — the same caps `pane.info`/`cwd.get` already gate reads on).
 * A per-project status board (`.pine/board.json`) agents can use to track work items
 * without a UI: columns + cards, seeded with `todo`/`doing`/`done` on first read.
 *
 * Unlike `wiki.ts`/`vault.ts`, the board has no `global` scope — a kanban board only makes
 * sense per project — so it fails closed on a missing session workDir exactly like those
 * do (see `vault.ts` for why: `jsonStore.storePath` would otherwise silently fall back to
 * `process.cwd()`, pooling every unrecognized session's board into one file).
 *
 * No `wiki.ts`-style prototype-pollution guard is needed here: card ids are server-generated
 * (`nextCardId`) and every caller-supplied field (`title`/`body`/`column`/`assignee`) is
 * written through a fixed, named property (`card.title = ...`), never used as a dynamic
 * object key (`obj[userInput] = ...`) — so there is no path from a crafted string to
 * `Object.prototype`. `kanban.add`/`kanban.update` do cap `title`/`body` size (64KB) and
 * `kanban.add` caps the board at 2000 cards (existing cards can still be updated once full).
 */
import { registerControlMethod } from './controlServer'
import { loadJson, saveJson, storePath } from './jsonStore'
import { workDirForSession } from './sessionRegistry'

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

/** Fails closed (returns `NoProjectWorkDir`) exactly like `vault.ts`'s `vaultStorePath`. */
function boardPath(sessionId: string): string | NoProjectWorkDir {
  const workDir = workDirForSession(sessionId)
  if (!workDir) return noProjectWorkDir()
  return storePath('board', 'project', workDir)
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

/** `title`/`body` size cap — keeps one card from ballooning the JSON board file. */
const MAX_FIELD_BYTES = 64 * 1024
/** Card count cap — `kanban.add` rejects new cards beyond this; updates to existing cards
 * (including moving/renaming/re-assigning) are still allowed once a board is full. */
const MAX_CARDS = 2000
const TOO_MANY_CARDS = {
  ok: false,
  error: 'too-many-cards' as const,
  message: `this board already has ${MAX_CARDS} cards — remove one before adding another`,
}

/** True iff `s` (a caller-supplied string field) exceeds `MAX_FIELD_BYTES` measured in bytes. */
function tooLarge(s: string | undefined): boolean {
  return s !== undefined && Buffer.byteLength(s, 'utf8') > MAX_FIELD_BYTES
}

/**
 * `card-<n>`, with `n` seeded from the highest numeric suffix already present in
 * `board.cards` — the same collision-avoidance the process manager's persisted-id counter
 * does, but recomputed on every call instead of cached in memory: the board isn't kept
 * resident across requests the way the process table is, it's loaded fresh from disk here.
 */
function nextCardId(board: KanbanBoard): string {
  let max = 0
  for (const card of board.cards) {
    const m = /^card-(\d+)$/.exec(card.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `card-${max + 1}`
}

/**
 * Read `sessionId`'s board. Exported (not just wired inline into `kanban.get`'s handler) so the
 * LAN gateway's phone-facing `board.get` (`src/main/gateway/controlDispatch.ts`, injected from
 * `index.ts`) can read the SAME board a pane's `kanban.get` would, without a session-scoped
 * `ControlMethod` context (the phone isn't a pane — it picks a `sessionId` itself; see that
 * module's header comment).
 */
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

/**
 * Apply `patch` to `cardId` on `sessionId`'s board. Exported (mirrors `kanbanGet` above) so the
 * LAN gateway's phone-facing `board.update` (`src/main/gateway/controlDispatch.ts`, injected
 * from `index.ts`) can write the SAME board a pane's `kanban.update` would, without a
 * session-scoped `ControlMethod` context (the phone isn't a pane — see `kanbanGet`'s comment).
 */
export function kanbanUpdate(
  sessionId: string,
  cardId: string,
  patch: Partial<Pick<KanbanCard, 'title' | 'body' | 'column' | 'assignee'>>,
): KanbanUpdateResult {
  const path = boardPath(sessionId)
  if (typeof path !== 'string') return path
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
    },
  })

  registerControlMethod('kanban.move', {
    cap: 'board-write',
    handler: (params, ctx) => {
      const path = boardPath(ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      const { cardId, column } = (params ?? {}) as { cardId: string; column: string }
      const board = loadBoard(path)
      const card = board.cards.find((c) => c.id === cardId)
      if (!card) return NOT_FOUND
      if (!board.columns.some((c) => c.id === column)) return UNKNOWN_COLUMN
      card.column = column
      card.updatedAt = new Date().toISOString()
      saveBoard(path, board)
      return { ok: true }
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
      const board = loadBoard(path)
      const idx = board.cards.findIndex((c) => c.id === cardId)
      if (idx === -1) return NOT_FOUND
      board.cards.splice(idx, 1)
      saveBoard(path, board)
      return { ok: true }
    },
  })
}
