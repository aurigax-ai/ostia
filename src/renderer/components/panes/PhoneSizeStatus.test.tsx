import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePhoneSizeStatus } from '@/components/panes/PhoneSizeStatus'
import { usePhoneSizeStore } from '@/stores/terminal/phoneSizeStore'

function Harness({ paneId }: { paneId: string }): JSX.Element {
  const line = usePhoneSizeStatus(paneId)
  return <div>{line}</div>
}

beforeEach(() => {
  usePhoneSizeStore.setState({ byPane: {} })
})

afterEach(cleanup)

describe('usePhoneSizeStatus', () => {
  it('shows nothing for a pane no phone sized', () => {
    render(<Harness paneId="p-mine" />)
    expect(screen.queryByText(/phone/)).toBeNull()
  })

  it('names the phone width and gives the window size back from its action', () => {
    const useDesktop = vi.fn()
    usePhoneSizeStore.getState().hold('p-mine', { cols: 44, useDesktop })
    render(<Harness paneId="p-mine" />)
    expect(screen.getByText('Sized for your phone (44 columns).')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: "Use this window's size" }))
    expect(useDesktop).toHaveBeenCalledTimes(1)
  })

  it('is a status line that leaves with the hold, and comes back with the next one', () => {
    usePhoneSizeStore.getState().hold('p-mine', { cols: 44, useDesktop: vi.fn() })
    const { container } = render(<Harness paneId="p-mine" />)
    expect(container.querySelector('[data-phone-sized]')).toBeInTheDocument()
    act(() => usePhoneSizeStore.getState().release('p-mine'))
    expect(container.querySelector('[data-phone-sized]')).toBeNull()
  })

  it('hides for good with its close button until the phone sizes the pane again', () => {
    usePhoneSizeStore.getState().hold('p-mine', { cols: 44, useDesktop: vi.fn() })
    const { container } = render(<Harness paneId="p-mine" />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(container.querySelector('[data-phone-sized]')).toBeNull()
    act(() => usePhoneSizeStore.getState().hold('p-mine', { cols: 40, useDesktop: vi.fn() }))
    expect(container.querySelector('[data-phone-sized]')).toBeInTheDocument()
  })
})
