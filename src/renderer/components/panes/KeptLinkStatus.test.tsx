import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useKeptLinkStatus } from '@/components/panes/KeptLinkStatus'
import { useKeptLinkStore } from '@/stores/terminal/keptLinkStore'

function Harness({ paneId }: { paneId: string }): JSX.Element {
  const line = useKeptLinkStatus(paneId)
  return <div>{line}</div>
}

beforeEach(() => {
  useKeptLinkStore.setState({ byPane: {} })
})

afterEach(cleanup)

describe('useKeptLinkStatus', () => {
  it('shows nothing while the link is up', () => {
    render(<Harness paneId="p-mine" />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says it is reconnecting and leaves when the link is back', () => {
    useKeptLinkStore.getState().set('p-mine', 'reconnecting')
    const { container } = render(<Harness paneId="p-mine" />)
    expect(screen.getByText('Reconnecting to the kept shells…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    act(() => useKeptLinkStore.getState().set('p-mine', 'up'))
    expect(container.querySelector('[data-kept-link]')).toBeNull()
  })

  it('offers Retry once the reconnect failed, and asks main to retry', () => {
    useKeptLinkStore.getState().set('p-mine', 'failed')
    render(<Harness paneId="p-mine" />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(window.ostia.pty.retryLink).toHaveBeenCalledWith('p-mine')
  })

  it('does not show another pane its link', () => {
    useKeptLinkStore.getState().set('p-other', 'failed')
    render(<Harness paneId="p-mine" />)
    expect(screen.queryByText(/kept shells/)).toBeNull()
  })
})
