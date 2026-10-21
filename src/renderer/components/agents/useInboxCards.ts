import { useMemo } from 'react'
import { type InboxCard, inboxCards, waitingCount } from '@/lib/agents/panelInbox'
import { useApprovalsStore } from '@/stores/agents/approvalsStore'
import { useQuestionsStore } from '@/stores/agents/questionsStore'
import { inboxItemsOf, useInboxStore } from '@/stores/extensions/inboxStore'
import { timedAttention, useSyncAttentionStore } from '@/stores/server/syncAttentionStore'
import { useWhere } from './NeedsYouCard'

export function useInboxCards(extId: string, workspaceId: string): InboxCard[] {
  const questions = useQuestionsStore((s) => s.pending)
  const sent = useQuestionsStore((s) => s.sent)
  const approvals = useApprovalsStore((s) => s.pending)
  const entries = useInboxStore((s) => s.entries)
  const attention = useSyncAttentionStore((s) => s.items)
  const seenAt = useSyncAttentionStore((s) => s.seenAt)
  const hidden = useSyncAttentionStore((s) => s.hidden)
  const whereOf = useWhere()
  return useMemo(
    () =>
      inboxCards({
        questions,
        sent,
        approvals,
        notes: inboxItemsOf(entries, extId, workspaceId),
        sync: timedAttention(attention, seenAt, hidden),
        workspaceId,
        whereOf,
      }),
    [questions, sent, approvals, entries, attention, seenAt, hidden, extId, workspaceId, whereOf],
  )
}

export function useInboxCount(extId: string, workspaceId: string): number {
  return waitingCount(useInboxCards(extId, workspaceId))
}
