import { useUpdateStore } from '@/stores/updateStore'
import type { InstallMethod, ReleaseState } from '@shared/installMethod'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { UpdateNotice } from './UpdateNotice'

const BUILD = { version: '1.0.0+sha.defdef', builtAt: '2026-09-30T11:00:00Z' }
const RELEASE = {
  version: '1.1.0',
  url: 'https://github.com/aurigax-ai/ostia/releases/tag/v1.1.0',
}
const APT_COMMAND = 'sudo apt update && sudo apt install --only-upgrade ostia'

function state(release: typeof RELEASE | null, method: InstallMethod = 'tarball'): ReleaseState {
  return { release, method, updateCommand: method === 'apt' ? APT_COMMAND : null, replace: null }
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

    act(() => useUpdateStore.getState().receive({ ...BUILD, version: '1.0.0+sha.123abc' }))
    expect(screen.getByRole('button', { name: 'Restart to update' })).toBeTruthy()
  })

  it('names a newer release and asks main to open its page, never a URL of its own', () => {
    render(<UpdateNotice />)
    act(() => useUpdateStore.getState().receiveRelease(state(RELEASE)))

    fireEvent.click(screen.getByRole('button', { name: 'Version 1.1.0 is available' }))

    expect(window.ostia.update.openRelease).toHaveBeenCalledWith()
    expect(window.ostia.update.restart).not.toHaveBeenCalled()
  })

  it('hides the release on Skip this version and tells main to remember it', () => {
    render(<UpdateNotice />)
    act(() => useUpdateStore.getState().receiveRelease(state(RELEASE)))

    fireEvent.click(screen.getByRole('button', { name: 'Skip this version' }))

    expect(screen.queryByRole('button', { name: 'Version 1.1.0 is available' })).toBeNull()
    expect(window.ostia.update.dismissRelease).toHaveBeenCalledTimes(1)
  })

  it('hides the release when main reports that none is pending', () => {
    render(<UpdateNotice />)
    act(() => useUpdateStore.getState().receiveRelease(state(RELEASE)))
    act(() => useUpdateStore.getState().receiveRelease(state(null)))

    expect(screen.queryByRole('button', { name: 'Version 1.1.0 is available' })).toBeNull()
  })

  it('offers the restart first when a new build is installed and a release is also pending', () => {
    render(<UpdateNotice />)
    act(() => {
      useUpdateStore.getState().receiveRelease(state(RELEASE))
      useUpdateStore.getState().receive(BUILD)
    })

    expect(screen.getByRole('button', { name: 'Restart to update' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Version 1.1.0 is available' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.getByRole('button', { name: 'Version 1.1.0 is available' })).toBeTruthy()
  })

  it('offers the install method’s update for an apt install and asks before anything runs', async () => {
    render(<UpdateNotice />)
    act(() => useUpdateStore.getState().receiveRelease(state(RELEASE, 'apt')))

    fireEvent.click(screen.getByRole('button', { name: 'Update with apt' }))
    expect(window.ostia.update.runUpdate).not.toHaveBeenCalled()
    expect(useUpdateStore.getState().confirming).toBe(true)

    await act(() => useUpdateStore.getState().confirmUpdate())
    expect(window.ostia.update.runUpdate).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled()

    act(() => useUpdateStore.getState().receiveUpdateRun({ status: 'done' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart Ostia' }))
    expect(window.ostia.update.restart).toHaveBeenCalled()
  })

  it('offers the update again after a failed run', () => {
    render(<UpdateNotice />)
    act(() => {
      useUpdateStore.getState().receiveRelease(state(RELEASE, 'apt'))
      useUpdateStore.getState().receiveUpdateRun({ status: 'running' })
    })
    act(() => useUpdateStore.getState().receiveUpdateRun({ status: 'failed', exitCode: 100 }))
    expect(screen.getByRole('button', { name: 'Update with apt' })).toBeEnabled()
  })
})
