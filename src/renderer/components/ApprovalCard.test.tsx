import type { ApprovalRequest } from '@shared/approvals'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newRequests, useApprovalsStore } from '../stores/approvalsStore'
import { ApprovalCard } from './ApprovalCard'

const REQUEST: ApprovalRequest = {
  id: 'approval-1',
  paneId: 'p1',
  workspaceId: 'w1',
  caps: ['shell'],
  action: 'Resume Agent',
  detail: '{"command":"agent.resume"}',
  at: 0,
}

describe('ApprovalCard', () => {
  afterEach(() => {
    vi.mocked(window.ostia.approvals.answer).mockClear()
    useApprovalsStore.setState({ pending: [], history: [] })
  })

  it('says which pane wants what, and answers with the button the human clicks', () => {
    render(<ApprovalCard request={REQUEST} paneTitle="claude" />)

    expect(screen.getByText(/claude wants to type commands into terminals/)).toBeTruthy()
    expect(screen.getByText('Resume Agent')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this pane' }))
    expect(window.ostia.approvals.answer).toHaveBeenCalledWith('approval-1', 'session')
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(window.ostia.approvals.answer).toHaveBeenCalledWith('approval-1', 'deny')
  })

  it('offers no session grant for destructive requests', () => {
    render(<ApprovalCard request={{ ...REQUEST, caps: ['destructive'] }} paneTitle="claude" />)

    expect(screen.queryByRole('button', { name: 'Allow for this pane' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()
  })

  it('offers no session grant for credentials, which main would refuse', () => {
    render(<ApprovalCard request={{ ...REQUEST, caps: ['credentials'] }} paneTitle="claude" />)

    expect(screen.queryByRole('button', { name: 'Allow for this pane' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()
  })
})

describe('newRequests', () => {
  it('returns only requests that were not pending before', () => {
    const second = { ...REQUEST, id: 'approval-2' }
    expect(newRequests([REQUEST], [REQUEST, second])).toEqual([second])
    expect(newRequests([REQUEST, second], [second])).toEqual([])
  })
})
