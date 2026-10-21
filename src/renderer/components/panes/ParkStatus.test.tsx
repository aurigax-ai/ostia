import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSidePanelStore } from '@/stores/app/sidePanelStore'
import { useParkStore } from '@/stores/workspaces/parkStore'
import { useParkStatus } from './ParkStatus'

function Status({ paneId, active }: { paneId: string; active: string | null }): JSX.Element {
  return <>{useParkStatus(paneId, 'w1', active)}</>
}

beforeEach(() => useParkStore.setState({ notice: null }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useParkStatus', () => {
  it('names the refusal on the pane that was refused, and on no other', () => {
    useParkStore.getState().showNotice({
      kind: 'refused',
      workspaceId: 'w1',
      paneId: 'p1',
      title: 'export-tests',
      reason: 'background-task',
    })
    const { container } = render(<Status paneId="p1" active="p1" />)
    expect(container).toHaveTextContent('Can’t park “export-tests”: a background task is running.')
    cleanup()
    expect(render(<Status paneId="p2" active="p2" />).container).toBeEmptyDOMElement()
  })

  it('says why a resume gave up, on the tab it opened, and keeps the record for Parked', () => {
    useParkStore.getState().showNotice({
      kind: 'resumeFailed',
      workspaceId: 'w1',
      paneId: 'p9',
      title: 'export-tests',
      reason: 'folder-missing',
    })
    const { container } = render(<Status paneId="p9" active="p1" />)
    expect(container).toHaveTextContent(
      'Could not resume “export-tests”: its folder no longer exists. It stays in Parked.',
    )
    cleanup()
    expect(render(<Status paneId="p1" active="p1" />).container).toBeEmptyDOMElement()
  })

  it('says it parked on the active pane of the workspace, and Show opens the Activity panel', async () => {
    useParkStore.getState().showNotice({ kind: 'parked', workspaceId: 'w1', title: 'export-tests' })
    expect(render(<Status paneId="p3" active="p2" />).container).toBeEmptyDOMElement()
    cleanup()
    const { container } = render(<Status paneId="p2" active="p2" />)
    expect(container).toHaveTextContent('Parked “export-tests”. Resume it from Activity › Parked.')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show' }))
    expect(useSidePanelStore.getState().right).toBe('activity')
    expect(useParkStore.getState().notice).toBeNull()
  })

  it('closes on dismiss and clears itself after a while', async () => {
    useParkStore.getState().showNotice({ kind: 'parked', workspaceId: 'w1', title: 't' })
    render(<Status paneId="p2" active="p2" />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(useParkStore.getState().notice).toBeNull())
    cleanup()
    vi.useFakeTimers()
    useParkStore.getState().showNotice({ kind: 'parked', workspaceId: 'w1', title: 't' })
    vi.advanceTimersByTime(15_001)
    expect(useParkStore.getState().notice).toBeNull()
  })
})
