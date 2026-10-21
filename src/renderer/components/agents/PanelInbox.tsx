import { type MouseEvent, useMemo } from 'react'
import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import { cardPane, type InboxCard, type InboxNote } from '@/lib/agents/panelInbox'
import { fmt, useDict } from '@/lib/app/useDict'
import { revealPane } from '@/lib/attention/workspaceActivity'
import { paneWhere } from '@/lib/sidebar/dashboard'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { CardMeta, NeedsYouCard } from './NeedsYouCard'
import { useInboxCards } from './useInboxCards'

const OWN_CONTROLS =
  'button, a, input, textarea, select, label, [role="radio"], [role="checkbox"], [role="button"]'

function focusOnCardClick(event: MouseEvent<HTMLElement>, paneId: string | undefined): void {
  if (!paneId) return
  if ((event.target as HTMLElement).closest(OWN_CONTROLS)) return
  revealPane(paneId)
}

function NoteCard({
  note,
  extId,
  workspaceId,
}: {
  note: InboxNote
  extId: string
  workspaceId: string
}): JSX.Element {
  const d = useDict()
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const layouts = useLayoutStore((s) => s.byWorkspace)
  const pane = useMemo(
    () => (note.paneId ? paneWhere(note.paneId, workspaces, layouts)?.pane : undefined),
    [note.paneId, workspaces, layouts],
  )
  const title = pane ?? d.attention.closedPane
  return (
    <article
      aria-label={fmt(d.dashboard.inboxNote, { pane: title })}
      data-inbox-note={note.id}
      className="dashboard-card flex flex-col gap-2 rounded-md border border-line bg-surface-1 p-3 text-fg text-ui-sm"
    >
      <CardMeta pane={title} at={note.at} />
      <p className="whitespace-pre-line [overflow-wrap:anywhere]">{note.text}</p>
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void window.ostia.extensions.inboxAction(extId, workspaceId, note.id)}
        >
          {d.dashboard.inboxMarkDone}
        </Button>
      </div>
    </article>
  )
}

function CardBody({
  card,
  extId,
  workspaceId,
}: {
  card: InboxCard
  extId: string
  workspaceId: string
}): JSX.Element {
  if (card.kind === 'note')
    return <NoteCard note={card.note} extId={extId} workspaceId={workspaceId} />
  return <NeedsYouCard item={card.item} where={card.where} compact />
}

export function PanelInbox({
  extId,
  workspaceId,
}: {
  extId: string
  workspaceId: string
}): JSX.Element {
  const d = useDict()
  const cards = useInboxCards(extId, workspaceId)
  if (cards.length === 0) {
    return (
      <div className="px-2">
        <EmptyState variant="block" title={d.dashboard.inboxEmpty} />
      </div>
    )
  }
  return (
    <ul aria-label={d.dashboard.inboxTab} className="flex flex-col gap-2 p-2">
      {cards.map((card) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the card's own controls and its Go to pane button are the keyboard path; a click elsewhere on it only shows its pane
        <li
          key={card.id}
          onClick={(event) => focusOnCardClick(event, cardPane(card))}
          className="cursor-default"
        >
          <CardBody card={card} extId={extId} workspaceId={workspaceId} />
        </li>
      ))}
    </ul>
  )
}
