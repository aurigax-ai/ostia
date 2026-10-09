import { newRequests, useApprovalsStore } from '@/stores/approvalsStore'
import type { ApprovalRequest } from '@shared/approvals'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('says which pane wants what, and answers once or denies with the buttons', () => {
    render(<ApprovalCard request={REQUEST} paneTitle="claude" />)

    expect(screen.getByText(/claude wants to type commands into terminals/)).toBeTruthy()
    expect(screen.getByText('Resume Agent')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(window.ostia.approvals.answer).toHaveBeenCalledWith('approval-1', 'once')
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(window.ostia.approvals.answer).toHaveBeenCalledWith('approval-1', 'deny')
  })

  it.each([
    ['Allow for this pane', 'session'],
    ['Always allow', 'always'],
  ])('offers %s under the caret', async (label, answer) => {
    render(<ApprovalCard request={REQUEST} paneTitle="claude" />)

    await userEvent.click(screen.getByRole('button', { name: 'More ways to allow' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: label }))

    expect(window.ostia.approvals.answer).toHaveBeenCalledWith('approval-1', answer)
  })

  it.each([['destructive'], ['credentials']] as const)(
    'offers only Allow once for %s, which main would refuse to grant',
    (cap) => {
      render(<ApprovalCard request={{ ...REQUEST, caps: [cap] }} paneTitle="claude" />)

      expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'More ways to allow' })).toBeNull()
    },
  )

  it('never offers Always allow for a request that is not a capability', async () => {
    render(
      <ApprovalCard
        request={{ ...REQUEST, caps: [], kind: 'secret', subject: 'GH_TOKEN' }}
        paneTitle="claude"
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'More ways to allow' }))

    expect(await screen.findByRole('menuitem', { name: 'Allow until restart' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Always allow' })).toBeNull()
  })
})

describe('newRequests', () => {
  it('returns only requests that were not pending before', () => {
    const second = { ...REQUEST, id: 'approval-2' }
    expect(newRequests([REQUEST], [REQUEST, second])).toEqual([second])
    expect(newRequests([REQUEST, second], [second])).toEqual([])
  })
})
