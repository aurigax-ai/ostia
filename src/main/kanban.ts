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

interface NoProjectWorkDir {
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

export function registerKanbanMethods(): void {
  registerControlMethod('kanban.get', {
    cap: 'read-board',
    handler: (_params, ctx) => {
      const path = boardPath(ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      return loadBoard(path)
    },
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
      const board = loadBoard(path)
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
      const path = boardPath(ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      const { cardId, patch } = (params ?? {}) as {
        cardId: string
        patch: Partial<Pick<KanbanCard, 'title' | 'body' | 'column' | 'assignee'>>
      }
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
