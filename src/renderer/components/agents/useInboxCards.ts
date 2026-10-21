import { useMemo } from 'react'
import { type InboxCard, inboxCards, waitingCount } from '@/lib/agents/panelInbox'
import { useApprovalsStore } from '@/stores/agents/approvalsStore'
import { useQuestionsStore } from '@/stores/agents/questionsStore'
import { inboxItemsOf, useInboxStore } from '@/stores/extensions/inboxStore'
import { useWhere } from './NeedsYouCard'

export function useInboxCards(extId: string, workspaceId: string): InboxCard[] {
  const questions = useQuestionsStore((s) => s.pending)
  const sent = useQuestionsStore((s) => s.sent)
  const approvals = useApprovalsStore((s) => s.pending)
  const entries = useInboxStore((s) => s.entries)
  const whereOf = useWhere()
  return useMemo(
    () =>
      inboxCards({
        questions,
        sent,
        approvals,
        notes: inboxItemsOf(entries, extId, workspaceId),
        workspaceId,
        whereOf,
      }),
    [questions, sent, approvals, entries, extId, workspaceId, whereOf],
  )
}

export function useInboxCount(extId: string, workspaceId: string): number {
  return waitingCount(useInboxCards(extId, workspaceId))
}
