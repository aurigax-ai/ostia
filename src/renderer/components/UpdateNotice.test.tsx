import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useUpdateStore } from '../stores/updateStore'
import { UpdateNotice } from './UpdateNotice'

const BUILD = { version: '1.0.0', commit: 'def', builtAt: '2026-09-30T11:00:00Z' }

describe('UpdateNotice', () => {
  afterEach(() => useUpdateStore.setState({ available: null, dismissed: null }))

  it('shows nothing until a new build is installed', () => {
    const { container } = render(<UpdateNotice />)
    expect(container.innerHTML).toBe('')
  })

  it('offers a restart for a new build, hides on Later, and returns for a newer build', () => {
    render(<UpdateNotice />)
    act(() => useUpdateStore.getState().receive(BUILD))

    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }))
    expect(window.pine.update.restart).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('button', { name: 'Restart to update' })).toBeNull()

    act(() => useUpdateStore.getState().receive({ ...BUILD, commit: 'ghi' }))
    expect(screen.getByRole('button', { name: 'Restart to update' })).toBeTruthy()
  })
})
