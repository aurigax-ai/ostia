import type { ReleaseCheckResult } from '@shared/releases'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { startUpdateWatch, useUpdateStore } from '../stores/updateStore'
import { UpdateCheck } from './UpdateCheck'

const RELEASE = {
  version: '1.1.0',
  url: 'https://github.com/aurigax-ai/pine/releases/tag/v1.1.0',
}

function answer(result: ReleaseCheckResult): void {
  vi.mocked(window.pine.update.checkRelease).mockResolvedValue(result)
}

const check = (): Promise<void> =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
  })

describe('UpdateCheck', () => {
  let updateInit: ReturnType<typeof useUpdateStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    updateInit = useUpdateStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    useUpdateStore.setState(updateInit, true)
    useSettingsStore.setState(settingsInit, true)
  })

  it('says nothing and offers no release before a check', () => {
    render(<UpdateCheck />)

    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(screen.queryByRole('button', { name: 'View release' })).toBeNull()
  })

  it('disables the button while main checks, then says the app is on the latest version', async () => {
    let finish: (result: ReleaseCheckResult) => void = () => {}
    vi.mocked(window.pine.update.checkRelease).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    render(<UpdateCheck />)

    await check()
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled()

    await act(async () => finish({ status: 'latest', version: '1.0.0' }))
    expect(screen.getByRole('status')).toHaveTextContent('You’re on the latest version.')
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'View release' })).toBeNull()
  })

  it('names the newer release and asks main to open its page', async () => {
    answer({ status: 'available', release: RELEASE })
    render(<UpdateCheck />)

    await check()
    fireEvent.click(await screen.findByRole('button', { name: 'View release' }))

    expect(screen.getByRole('status')).toHaveTextContent('Version 1.1.0 is available')
    expect(window.pine.update.openRelease).toHaveBeenCalledWith()
  })

  it.each([
    ['offline', 'Couldn’t reach GitHub. Check your connection and try again.'],
    ['rate-limited', 'GitHub is limiting requests right now. Try again later.'],
    ['unavailable', 'Couldn’t read the latest release. Try again later.'],
  ] as const)('shows a short error when the check fails as %s', async (error, text) => {
    answer({ status: 'error', error })
    render(<UpdateCheck />)

    await check()

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(text))
    expect(screen.queryByRole('button', { name: 'View release' })).toBeNull()
  })

  it('shows an error when the bridge call itself fails', async () => {
    vi.mocked(window.pine.update.checkRelease).mockRejectedValue(new Error('no handler'))
    render(<UpdateCheck />)

    await check()

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Couldn’t read the latest release. Try again later.',
      ),
    )
  })

  it('shows a release the automatic check already found, before any manual check', async () => {
    vi.mocked(window.pine.update.release).mockResolvedValue(RELEASE)
    render(<UpdateCheck />)
    let stop = (): void => {}
    await act(async () => {
      stop = startUpdateWatch()
    })

    expect(await screen.findByRole('button', { name: 'View release' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Version 1.1.0 is available')
    stop()
  })

  it('follows releases main announces and stops when the watch ends', () => {
    let announce: (release: typeof RELEASE | null) => void = () => {}
    const unsubscribe = vi.fn()
    vi.mocked(window.pine.update.onRelease).mockImplementation((cb) => {
      announce = cb
      return unsubscribe
    })
    const stop = startUpdateWatch()

    act(() => announce(RELEASE))
    expect(useUpdateStore.getState().release).toEqual(RELEASE)
    act(() => announce(null))
    expect(useUpdateStore.getState().release).toBeNull()

    stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('turns the automatic check off and on from its switch', () => {
    render(<UpdateCheck />)
    const toggle = screen.getByRole('switch', { name: 'Check for updates automatically' })
    expect(toggle).toBeChecked()

    fireEvent.click(toggle)
    expect(useSettingsStore.getState().behavior.checkForUpdates).toBe(false)

    fireEvent.click(toggle)
    expect(useSettingsStore.getState().behavior.checkForUpdates).toBe(true)
  })
})
