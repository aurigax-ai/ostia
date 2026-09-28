import type { KanbanBoard, KanbanCard, KanbanColumn, KanbanMutateOp } from '@shared/types'
import { Plus, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { useSessionsStore } from '../stores/sessionsStore'
import { IconButton } from './IconButton'
import { Button } from './ui/button'
import { Input } from './ui/input'

type KanbanFailure = { ok: false; error: string; message?: string }

function isFailure(b: KanbanBoard | KanbanFailure): b is KanbanFailure {
  return 'error' in b
}

function useWorkDir(sessionId: string): string {
  return useSessionsStore((s) => s.sessions.find((c) => c.id === sessionId)?.workDir ?? '~')
}

export function KanbanView({ sessionId }: { sessionId: string }): JSX.Element {
  const d = useDict()
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
      <div className="flex h-full w-full items-center justify-center bg-surface-1 p-4 text-center text-attn-fg text-ui-sm">
        {error}
      </div>
    )
  }

  if (!board) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-1 text-fg-muted text-ui-sm">
        {d.kanban.loading}
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
  const d = useDict()
  const [draft, setDraft] = useState('')

  const add = (): void => {
    const title = draft.trim()
    if (!title) return
    setDraft('')
    onMutate({ op: 'add', title, column: column.id })
  }

  return (
    <div className="flex h-full w-64 shrink-0 flex-col rounded-lg border border-line bg-surface-2">
      <div className="border-line border-b px-3 py-2 font-medium text-fg text-ui-sm">
        {column.name} <span className="text-fg-muted">({cards.length})</span>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
        {cards.length === 0 ? (
          <div className="px-1 py-2 text-center text-fg-muted text-ui-sm">{d.kanban.noCards}</div>
        ) : (
          cards.map((card) => (
            <Card key={card.id} card={card} columns={columns} onMutate={onMutate} />
          ))
        )}
      </div>
      <div className="flex items-center gap-1 border-line border-t p-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          placeholder={d.kanban.addPlaceholder}
          aria-label={d.kanban.addPlaceholder}
          className="h-7 flex-1"
        />
        <IconButton size="bar" icon={Plus} label={d.kanban.add} onClick={add} />
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
  const d = useDict()
  return (
    <div className="group relative rounded-md border border-line bg-surface-1 p-2 text-ui-sm">
      <IconButton
        icon={X}
        label={d.kanban.remove}
        onClick={() => onMutate({ op: 'remove', cardId: card.id })}
        className="absolute top-1 right-1 opacity-0 hover:text-attn-fg focus-visible:opacity-100 group-hover:opacity-100"
      />
      <div className="pr-6 text-fg">{card.title}</div>
      {card.assignee ? <div className="mt-1 text-fg-muted">{card.assignee}</div> : null}
      <div className="mt-2 flex flex-wrap gap-1">
        {columns
          .filter((c) => c.id !== card.column)
          .map((c) => (
            <Button
              key={c.id}
              variant="outline"
              size="xs"
              aria-label={fmt(d.kanban.moveTo, { column: c.name })}
              onClick={() => onMutate({ op: 'move', cardId: card.id, column: c.id })}
            >
              → {c.name}
            </Button>
          ))}
      </div>
    </div>
  )
}
