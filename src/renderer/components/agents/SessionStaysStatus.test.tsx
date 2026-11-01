import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startSessionStays, useSessionStaysStore } from '@/stores/agents/sessionStaysStore'
import { useSessionStaysStatus } from './SessionStaysStatus'

function Status({ paneId }: { paneId: string }): JSX.Element | null {
  return useSessionStaysStatus(paneId)
}

describe('SessionStaysStatus', () => {
  afterEach(() => {
    cleanup()
    useSessionStaysStore.setState({ byPane: {} })
  })

  it('CLA-M7 tells the human in that pane only that its session stays on the old account, until dismissed', () => {
    let push: (paneId: string) => void = () => {}
    vi.mocked(window.ostia.claudeAccounts.onSessionStays).mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    const stop = startSessionStays()
    render(
      <>
        <Status paneId="p1" />
        <Status paneId="p2" />
      </>,
    )
    expect(screen.queryByLabelText('Claude account not changed')).toBeNull()
    act(() => push('p1'))
    const line = screen.getByLabelText('Claude account not changed')
    expect(line.textContent).toContain('stays on the account it started on')
    expect(screen.getAllByLabelText('Claude account not changed')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByLabelText('Claude account not changed')).toBeNull()
    stop()
  })
})
