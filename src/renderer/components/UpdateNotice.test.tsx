import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useUpdateStore } from '../stores/updateStore'
import { UpdateNotice } from './UpdateNotice'

const BUILD = { version: '1.0.0', commit: 'def', builtAt: '2026-09-30T11:00:00Z' }
const RELEASE = {
  version: '1.1.0',
  url: 'https://github.com/aurigax-ai/ostia/releases/tag/v1.1.0',
}

describe('UpdateNotice', () => {
  let init: ReturnType<typeof useUpdateStore.getState>

  beforeAll(() => {
    init = useUpdateStore.getState()
  })

  afterEach(() => {
    cleanup()

    useUpdateStore.setState(init, true)
  })
  it('shows nothing until a new build is installed', () => {
    const { container } = render(<UpdateNotice />)
    expect(container.innerHTML).toBe('')
  })

  it('offers a restart for a new build, hides on Later, and returns for a newer build', () => {
    render(<UpdateNotice />)
    act(() => useUpdateStore.getState().receive(BUILD))

    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }))
    expect(window.ostia.update.restart).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('button', { name: 'Restart to update' })).toBeNull()

    act(() => useUpdateStore.getState().receive({ ...BUILD, commit: 'ghi' }))
    expect(screen.getByRole('button', { name: 'Restart to update' })).toBeTruthy()
  })

  it('names a newer release and asks main to open its page, never a URL of its own', () => {
    render(<UpdateNotice />)
    act(() => useUpdateStore.getState().receiveRelease(RELEASE))

    fireEvent.click(screen.getByRole('button', { name: 'Version 1.1.0 is available' }))

    expect(window.ostia.update.openRelease).toHaveBeenCalledWith()
    expect(window.ostia.update.restart).not.toHaveBeenCalled()
  })

  it('hides the release on Skip this version and tells main to remember it', () => {
    render(<UpdateNotice />)
    act(() => useUpdateStore.getState().receiveRelease(RELEASE))

    fireEvent.click(screen.getByRole('button', { name: 'Skip this version' }))

    expect(screen.queryByRole('button', { name: 'Version 1.1.0 is available' })).toBeNull()
    expect(window.ostia.update.dismissRelease).toHaveBeenCalledTimes(1)
  })

  it('hides the release when main reports that none is pending', () => {
    render(<UpdateNotice />)
    act(() => useUpdateStore.getState().receiveRelease(RELEASE))
    act(() => useUpdateStore.getState().receiveRelease(null))

    expect(screen.queryByRole('button', { name: 'Version 1.1.0 is available' })).toBeNull()
  })

  it('offers the restart first when a new build is installed and a release is also pending', () => {
    render(<UpdateNotice />)
    act(() => {
      useUpdateStore.getState().receiveRelease(RELEASE)
      useUpdateStore.getState().receive(BUILD)
    })

    expect(screen.getByRole('button', { name: 'Restart to update' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Version 1.1.0 is available' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.getByRole('button', { name: 'Version 1.1.0 is available' })).toBeTruthy()
  })
})
