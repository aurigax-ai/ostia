import { isPaneViewed, signalPane } from '@/lib/attention/workspaceActivity'
import { wantsDesktopBanner } from '@shared/app/notificationSettings'
import type {
  ApprovalAnswer,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalState,
} from '@shared/permissions/approvals'
import { create } from 'zustand'
import { currentDict, fmt } from '../i18n/useDict'
import { useAttentionStore } from './attentionStore'
import { useSettingsStore } from './settingsStore'

interface ApprovalsState {
  pending: ApprovalRequest[]
  history: ApprovalRecord[]
  apply: (state: ApprovalState) => void
  answer: (id: string, answer: ApprovalAnswer) => Promise<void>
  revoke: (id: string) => Promise<void>
}

export const useApprovalsStore = create<ApprovalsState>((set) => ({
  pending: [],
  history: [],
  apply: (state) => set({ pending: state.pending, history: state.history }),
  answer: async (id, answer) => {
    await window.ostia.approvals.answer(id, answer)
  },
  revoke: async (id) => {
    await window.ostia.approvals.revoke(id)
  },
}))

export function newRequests(
  before: readonly ApprovalRequest[],
  after: readonly ApprovalRequest[],
): ApprovalRequest[] {
  const known = new Set(before.map((r) => r.id))
  return after.filter((r) => !known.has(r.id))
}

function approvalMessage(req: ApprovalRequest): string {
  return fmt(currentDict().approvals.needs, { caps: req.caps.join(', ') })
}

function settle(req: ApprovalRequest): void {
  const attention = useAttentionStore.getState()
  const current = attention.byPane[req.paneId]
  if (current?.state !== 'waiting' || current.message !== approvalMessage(req)) return
  attention.dispatch(req.paneId, { type: 'waitEnded', at: Date.now() })
}

function announce(req: ApprovalRequest): void {
  const d = currentDict()
  const message = approvalMessage(req)
  signalPane(req.paneId, { type: 'set', state: 'waiting', message, at: Date.now() })
  window.ostia.notifications.post({
    paneId: req.paneId,
    kind: 'approval',
    title: d.approvals.title,
    body: `${message}: ${req.action}`,
    desktop: wantsDesktopBanner(
      useSettingsStore.getState().notifications,
      'agentWaiting',
      isPaneViewed(req.paneId) && document.hasFocus(),
    ),
  })
}

export function startApprovals(): () => void {
  const receive = (state: ApprovalState): void => {
    const before = useApprovalsStore.getState().pending
    const added = newRequests(before, state.pending)
    const gone = newRequests(state.pending, before)
    useApprovalsStore.getState().apply(state)
    for (const req of gone) settle(req)
    for (const req of added) announce(req)
  }
  const off = window.ostia.approvals.onChange(receive)
  void window.ostia.approvals.state().then(receive)
  return off
}
