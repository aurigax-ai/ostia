import type { QuestionRequest } from '@shared/agents/questions'
import type { ApprovalRequest } from '@shared/permissions/approvals'
import { type NeedsYouItem, needsYouItems, type PaneWhere } from '@/lib/sidebar/dashboard'
import type { TimedAttention } from '@/stores/server/syncAttentionStore'

export interface InboxNote {
  id: string
  text: string
  paneId?: string
  at: number
}

export type InboxCard =
  | { kind: 'item'; id: string; at: number; item: NeedsYouItem; where: PaneWhere | null }
  | { kind: 'note'; id: string; at: number; note: InboxNote }
  | { kind: 'sync'; id: string; at: number; sync: TimedAttention['item'] }

export function cardPane(card: InboxCard): string | undefined {
  if (card.kind === 'sync') return undefined
  if (card.kind === 'note') return card.note.paneId
  return card.item.kind === 'question' ? card.item.question.paneId : card.item.approval.paneId
}

function inWorkspace(item: NeedsYouItem, where: PaneWhere | null, workspaceId: string): boolean {
  if (item.kind === 'approval') return item.approval.workspaceId === workspaceId
  return where?.workspaceId === workspaceId
}

export function inboxCards({
  questions,
  sent,
  approvals,
  notes,
  sync,
  workspaceId,
  whereOf,
}: {
  questions: readonly QuestionRequest[]
  sent: readonly QuestionRequest[]
  approvals: readonly ApprovalRequest[]
  notes: readonly InboxNote[]
  sync: readonly TimedAttention[]
  workspaceId: string
  whereOf: (item: NeedsYouItem) => PaneWhere | null
}): InboxCard[] {
  const items = needsYouItems(questions, sent, approvals).flatMap((item): InboxCard[] => {
    const where = whereOf(item)
    return inWorkspace(item, where, workspaceId)
      ? [{ kind: 'item', id: item.id, at: item.at, item, where }]
      : []
  })
  const cards: InboxCard[] = [
    ...items,
    ...notes.map((note): InboxCard => ({ kind: 'note', id: note.id, at: note.at, note })),
    ...sync.map(
      ({ item, at }): InboxCard => ({ kind: 'sync', id: `sync:${item.id}`, at, sync: item }),
    ),
  ]
  return cards.sort((a, b) => a.at - b.at)
}

export function waitingCount(cards: readonly InboxCard[]): number {
  return cards.filter(
    (card) => card.kind !== 'item' || card.item.kind === 'approval' || !card.item.sent,
  ).length
}
