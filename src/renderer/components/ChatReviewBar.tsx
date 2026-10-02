import { CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { editHunks, hunkCounts } from '../lib/chatHunks'
import { type ReviewItem, acceptAll, rejectAll, reviewItems } from '../lib/chatReview'
import { useChatToolsStore } from '../stores/chatToolsStore'
import { IconButton } from './IconButton'
import { Button } from './ui/button'

export const REVIEW_BAR_MIN = 2

function revealCard(toolCallId: string): void {
  const card = document.querySelector<HTMLElement>(`[data-edit-call="${CSS.escape(toolCallId)}"]`)
  card?.scrollIntoView?.({ block: 'nearest' })
  card?.focus({ preventScroll: true })
}

export function ChatReviewBar({ sessionId }: { sessionId: string }): JSX.Element | null {
  const d = useDict()
  const r = d.chatTools.review
  const pending = useChatToolsStore((s) => s.pending)
  const edits = useChatToolsStore((s) => s.edits)
  const choices = useChatToolsStore((s) => s.hunkChoices)
  const items = useMemo(() => reviewItems(sessionId, pending, edits), [sessionId, pending, edits])
  const [at, setAt] = useState(0)
  const files = useMemo(() => [...new Set(items.map((i) => i.path))], [items])
  const totals = useMemo(() => {
    let added = 0
    let removed = 0
    for (const item of items) {
      const source = item.pending ? pending[item.toolCallId]?.detail : edits[item.toolCallId]
      if (source?.before === undefined || source.after === undefined) continue
      const decisions = item.pending
        ? (choices[item.toolCallId] ?? [])
        : (edits[item.toolCallId]?.decisions ?? [])
      const counts = hunkCounts(editHunks(source.before, source.after), decisions)
      added += counts.added
      removed += counts.removed
    }
    return { added, removed }
  }, [items, pending, edits, choices])
  if (items.length < REVIEW_BAR_MIN) return null
  const index = Math.min(at, files.length - 1)
  const step = (by: number): void => {
    const next = (index + by + files.length) % files.length
    setAt(next)
    const first = items.find((i: ReviewItem) => i.path === files[next])
    if (first) revealCard(first.toolCallId)
  }
  const current = files[index] ?? ''
  return (
    <section
      aria-label={r.region}
      className="chat-review-bar flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-line border-b bg-surface-1 px-2 py-1"
    >
      <span className="text-fg text-ui-xs">
        {fmt(r.summary, { edits: items.length, files: files.length })}
      </span>
      <span className="flex gap-1.5 font-mono text-ui-xs tabular-nums">
        <span className="text-add">+{totals.added}</span>
        <span className="text-del">-{totals.removed}</span>
      </span>
      <span className="ml-auto flex min-w-0 items-center gap-0.5">
        <IconButton icon={CaretUpIcon} label={r.previous} onClick={() => step(-1)} />
        <span className="min-w-0 truncate text-fg-muted text-ui-xs">
          {fmt(r.position, {
            n: index + 1,
            count: files.length,
            name: current.split('/').pop() || current,
          })}
        </span>
        <IconButton icon={CaretDownIcon} label={r.next} onClick={() => step(1)} />
      </span>
      <span className="flex items-center gap-1">
        <Button type="button" variant="outline" size="xs" onClick={() => void rejectAll(items)}>
          {r.rejectAll}
        </Button>
        <Button type="button" size="xs" onClick={() => acceptAll(items)}>
          {r.acceptAll}
        </Button>
      </span>
    </section>
  )
}
