import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as parkTab from '@/lib/park/parkTab'
import { useParkStore } from '@/stores/workspaces/parkStore'
import { ParkPrompt } from './ParkPrompt'
import { useParkStatus } from './ParkStatus'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  useParkStore.setState({
    prompt: { workspaceId: 'w1', paneId: 'p1', title: 'export-tests' },
    notice: null,
  })
})

describe('ParkPrompt', () => {
  it('asks to park the tab, with a note field that has the keyboard', () => {
    render(<ParkPrompt title="export-tests" />)
    expect(screen.getByText('Park “export-tests”?')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Note (optional)')).toHaveFocus()
  })

  it('parks with the typed note on Enter and on the Park button', async () => {
    const confirm = vi.spyOn(parkTab, 'confirmPark').mockResolvedValue()
    const user = userEvent.setup()
    render(<ParkPrompt title="export-tests" />)
    await user.type(screen.getByPlaceholderText('Note (optional)'), 'after lunch{Enter}')
    expect(confirm).toHaveBeenLastCalledWith('after lunch')
    await user.click(screen.getByRole('button', { name: 'Park' }))
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('does nothing on Escape, Cancel or the close button except close the card', async () => {
    const confirm = vi.spyOn(parkTab, 'confirmPark').mockResolvedValue()
    const user = userEvent.setup()
    render(<ParkPrompt title="export-tests" />)
    fireEvent.keyDown(screen.getByPlaceholderText('Note (optional)'), { key: 'Escape' })
    expect(useParkStore.getState().prompt).toBeNull()
    useParkStore.setState({ prompt: { workspaceId: 'w1', paneId: 'p1', title: 't' } })
    await user.click(screen.getAllByRole('button', { name: 'Cancel' })[0])
    expect(useParkStore.getState().prompt).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
  })
})

function Status({ paneId, active }: { paneId: string; active: string | null }): JSX.Element {
  return <>{useParkStatus(paneId, 'w1', active)}</>
}

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
    const other = render(<Status paneId="p2" active="p2" />)
    expect(other.container).toBeEmptyDOMElement()
  })

  it('says it parked, on the active pane of the workspace, and closes on dismiss', async () => {
    useParkStore.getState().showNotice({ kind: 'parked', workspaceId: 'w1', title: 'export-tests' })
    const { container } = render(<Status paneId="p2" active="p2" />)
    expect(container).toHaveTextContent('Parked “export-tests”. Resume it from Activity › Parked.')
    cleanup()
    expect(render(<Status paneId="p3" active="p2" />).container).toBeEmptyDOMElement()
    cleanup()
    render(<Status paneId="p2" active="p2" />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(useParkStore.getState().notice).toBeNull())
  })

  it('clears itself after a while', () => {
    vi.useFakeTimers()
    useParkStore.getState().showNotice({ kind: 'parked', workspaceId: 'w1', title: 't' })
    vi.advanceTimersByTime(15_001)
    expect(useParkStore.getState().notice).toBeNull()
    vi.useRealTimers()
  })
})
