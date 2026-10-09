import type { ApprovalRequest, ApprovalState } from '@shared/permissions/approvals'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startApprovals, useApprovalsStore } from './approvalsStore'
import { useAttentionStore } from './attentionStore'

const approvalsInit = useApprovalsStore.getState()
const attentionInit = useAttentionStore.getState()

const request: ApprovalRequest = {
  id: 'r1',
  paneId: 'p1',
  workspaceId: 'w1',
  caps: ['browse'],
  action: 'browse.open',
  detail: '',
  at: 1,
}

function listen(): (state: ApprovalState) => void {
  let receive: ((state: ApprovalState) => void) | undefined
  vi.mocked(window.ostia.approvals.onChange).mockImplementation((cb) => {
    receive = cb
    return () => {}
  })
  startApprovals()
  if (!receive) throw new Error('no listener')
  return receive
}

afterEach(() => {
  useApprovalsStore.setState(approvalsInit, true)
  useAttentionStore.setState(attentionInit, true)
})

describe('startApprovals', () => {
  it('puts the pane in waiting while the request is pending and clears it once answered', () => {
    const receive = listen()
    receive({ pending: [request], history: [] })
    expect(useAttentionStore.getState().byPane.p1?.state).toBe('waiting')
    receive({ pending: [], history: [] })
    expect(useAttentionStore.getState().byPane.p1).toMatchObject({ state: 'none', unread: false })
  })

  it('keeps a waiting the agent reported itself after the request is answered', () => {
    const receive = listen()
    receive({ pending: [request], history: [] })
    useAttentionStore
      .getState()
      .dispatch('p1', { type: 'set', state: 'waiting', message: 'Pick a branch', at: 2 })
    receive({ pending: [], history: [] })
    expect(useAttentionStore.getState().byPane.p1).toMatchObject({
      state: 'waiting',
      message: 'Pick a branch',
    })
  })
})
