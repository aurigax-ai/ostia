import { PaneAgentNotices } from '@/components/panes/PaneAgentNotices'
import { PhoneSizeNotice } from '@/components/panes/PhoneSizeNotice'
import { createPane } from '@/lib/layout/tree'
import { usePhoneSizeStore } from '@/stores/terminal/phoneSizeStore'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mine = { ...createPane('terminal', 'mine'), id: 'p-mine' }

beforeEach(() => {
  usePhoneSizeStore.setState({ byPane: {} })
})

afterEach(cleanup)

describe('PhoneSizeNotice', () => {
  it('shows nothing for a pane no phone sized', () => {
    render(<PhoneSizeNotice paneId="p-mine" />)
    expect(screen.queryByText(/phone/)).toBeNull()
  })

  it('names the phone width and gives the window size back from its action', () => {
    const useDesktop = vi.fn()
    usePhoneSizeStore.getState().hold('p-mine', { cols: 44, useDesktop })
    render(<PhoneSizeNotice paneId="p-mine" />)
    expect(screen.getByText('Sized for your phone (44 columns).')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: "Use this window's size" }))
    expect(useDesktop).toHaveBeenCalledTimes(1)
  })

  it('is what a phone-sized pane shows in its strip, and leaves with the hold', () => {
    usePhoneSizeStore.getState().hold('p-mine', { cols: 44, useDesktop: vi.fn() })
    const { container } = render(<PaneAgentNotices pane={mine} />)
    expect(container.querySelector('[data-phone-sized]')).toBeInTheDocument()
    act(() => usePhoneSizeStore.getState().release('p-mine'))
    expect(container.querySelector('[data-phone-sized]')).toBeNull()
  })
})
