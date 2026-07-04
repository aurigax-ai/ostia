import type { KanbanBoard, KanbanCard, KanbanColumn, KanbanMutateOp } from '@shared/types'
import { Plus, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useSessionsStore } from '../stores/sessionsStore'

type KanbanFailure = { ok: false; error: string; message?: string }

function isFailure(b: KanbanBoard | KanbanFailure): b is KanbanFailure {
  return 'error' in b
}

/** The pane's own session's workDir (NOT the globally active session) — a kanban pane keeps
 *  showing its session's project board even while another session is focused. */
function useWorkDir(sessionId: string): string {
  return useSessionsStore((s) => s.sessions.find((c) => c.id === sessionId)?.workDir ?? '~')
}

/**
 * The `kanban` surface: a project board (columns as vertical lists of cards), backed by
 * `window.pine.kanban` — the SAME `.pine/board.json` store the `kanban.*` agent-toolbelt
 * control methods read/write (`src/main/kanban.ts`). Refetches on window focus (an agent/CLI
 * may have mutated the board out of band) and applies every local mutation optimistically via
 * the fresh board `kanban:mutate` returns (no extra round trip).
 */
export function KanbanView({ sessionId }: { sessionId: string }): JSX.Element {
  const workDir = useWorkDir(sessionId)
  const [board, setBoard] = useState<KanbanBoard | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    window.pine.kanban.get(workDir).then((b) => {
      if (isFailure(b)) {
        setError(b.message ?? b.error)
        setBoard(null)
      } else {
        setError(null)
        setBoard(b)
      }
    })
  }, [workDir])

  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  const mutate = useCallback(
    async (op: KanbanMutateOp) => {
      const result = await window.pine.kanban.mutate(workDir, op)
      if (result.ok) {
        setError(null)
        setBoard(result.board)
      } else {
        setError(result.message ?? result.error)
      }
    },
    [workDir],
  )

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-1 p-4 text-center text-fg-dim text-xs">
        {error}
      </div>
    )
  }

  if (!board) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-1 text-fg-dim text-xs">
        Loading…
      </div>
    )
  }

  return (
    <div className="flex h-full w-full items-start gap-3 overflow-x-auto bg-surface-1 p-3">
      {board.columns.map((col) => (
        <Column
          key={col.id}
          column={col}
          columns={board.columns}
          cards={board.cards.filter((c) => c.column === col.id)}
          onMutate={mutate}
        />
      ))}
    </div>
  )
}

function Column({
  column,
  columns,
  cards,
  onMutate,
}: {
  column: KanbanColumn
  columns: KanbanColumn[]
  cards: KanbanCard[]
  onMutate: (op: KanbanMutateOp) => void
}): JSX.Element {
  const [draft, setDraft] = useState('')

  const add = (): void => {
    const title = draft.trim()
    if (!title) return
    setDraft('')
    onMutate({ op: 'add', title, column: column.id })
  }

  return (
    <div className="flex h-full w-64 shrink-0 flex-col rounded-lg border border-line bg-surface-2">
      <div className="border-line border-b px-3 py-2 font-medium text-fg text-xs">
        {column.name} <span className="text-fg-dim">({cards.length})</span>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
        {cards.length === 0 ? (
          <div className="px-1 py-2 text-center text-fg-dim text-xs">No cards</div>
        ) : (
          cards.map((card) => (
            <Card key={card.id} card={card} columns={columns} onMutate={onMutate} />
          ))
        )}
      </div>
      <div className="flex items-center gap-1 border-line border-t p-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          placeholder="Add a card…"
          className="h-7 flex-1 rounded-md border border-line bg-bg-sunken px-2 text-fg text-xs outline-none focus:border-brand"
        />
        <button
          type="button"
          onClick={add}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line text-fg-muted hover:border-line-strong hover:text-fg"
        >
          <Plus size={13} />
        </button>
      </div>
    </div>
  )
}

function Card({
  card,
  columns,
  onMutate,
}: {
  card: KanbanCard
  columns: KanbanColumn[]
  onMutate: (op: KanbanMutateOp) => void
}): JSX.Element {
  return (
    <div className="group relative rounded-md border border-line bg-surface-1 p-2 text-xs">
      <button
        type="button"
        onClick={() => onMutate({ op: 'remove', cardId: card.id })}
        aria-label="Remove card"
        className="absolute top-1 right-1 hidden text-fg-dim hover:text-attn group-hover:block"
      >
        <X size={12} />
      </button>
      <div className="pr-4 text-fg">{card.title}</div>
      {card.assignee ? <div className="mt-1 text-fg-dim">{card.assignee}</div> : null}
      <div className="mt-2 flex flex-wrap gap-1">
        {columns
          .filter((c) => c.id !== card.column)
          .map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onMutate({ op: 'move', cardId: card.id, column: c.id })}
              className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-dim hover:border-brand hover:text-brand"
            >
              → {c.name}
            </button>
          ))}
      </div>
    </div>
  )
}
