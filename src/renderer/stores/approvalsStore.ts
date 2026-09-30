import type {
  ApprovalAnswer,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalState,
} from '@shared/approvals'
import { wantsDesktopBanner } from '@shared/notificationSettings'
import { create } from 'zustand'
import { currentDict, fmt } from '../i18n/useDict'
import { isPaneViewed, signalPane } from '../lib/workspaceActivity'
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
    await window.pine.approvals.answer(id, answer)
  },
  revoke: async (id) => {
    await window.pine.approvals.revoke(id)
  },
}))

export function newRequests(
  before: readonly ApprovalRequest[],
  after: readonly ApprovalRequest[],
): ApprovalRequest[] {
  const known = new Set(before.map((r) => r.id))
  return after.filter((r) => !known.has(r.id))
}

function announce(req: ApprovalRequest): void {
  const d = currentDict()
  const message = fmt(d.approvals.needs, { caps: req.caps.join(', ') })
  signalPane(req.paneId, { type: 'set', state: 'waiting', message, at: Date.now() })
  window.pine.notifications.post({
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
    const added = newRequests(useApprovalsStore.getState().pending, state.pending)
    useApprovalsStore.getState().apply(state)
    for (const req of added) announce(req)
  }
  const off = window.pine.approvals.onChange(receive)
  void window.pine.approvals.state().then(receive)
  return off
}
