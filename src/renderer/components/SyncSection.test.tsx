import type { SyncStatus } from '@shared/types'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { SyncSection } from './SyncSection'

const status = (s: Partial<SyncStatus>): SyncStatus => ({
  dir: null,
  state: 'off',
  lastSync: null,
  lastConflict: null,
  ...s,
})

describe('SyncSection', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    useSettingsStore.setState(settingsInit, true)
  })

  it('shows sync as off with no folder and disables Sync now', async () => {
    render(<SyncSection />)
    expect(screen.getByText('Not set')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Off')
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Stop syncing' })).toBeNull()
  })

  it('saves the picked folder into settings.json and syncs right away', async () => {
    const pine = window.pine
    vi.mocked(pine.sync.pickFolder).mockResolvedValue('/home/me/Sync/pine')
    vi.mocked(pine.sync.run).mockResolvedValue(
      status({ dir: '/home/me/Sync/pine', state: 'ok', lastSync: '2026-09-28T10:00:00.000Z' }),
    )
    render(<SyncSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await waitFor(() => expect(pine.sync.run).toHaveBeenCalled())
    expect(useSettingsStore.getState().sync).toEqual({ dir: '/home/me/Sync/pine' })
    const written = vi.mocked(pine.fs.write).mock.calls.at(-1)
    expect(written?.[0]).toBe('/tmp/pine-test/settings.json')
    expect(JSON.parse(String(written?.[1]))).toMatchObject({ sync: { dir: '/home/me/Sync/pine' } })
    expect(screen.getByText('/home/me/Sync/pine')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/^Last synced /)
  })

  it('does nothing when the folder picker is cancelled', async () => {
    render(<SyncSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    expect(window.pine.sync.run).not.toHaveBeenCalled()
    expect(window.pine.fs.write).not.toHaveBeenCalled()
  })

  it('explains a missing folder and a conflict from live status updates', async () => {
    useSettingsStore.setState({ sync: { dir: '/mnt/gone' } })
    let push: (s: SyncStatus) => void = () => {}
    vi.mocked(window.pine.sync.onStatus).mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    render(<SyncSection />)
    act(() => push(status({ dir: '/mnt/gone', state: 'error', error: 'missing' })))
    expect(screen.getByRole('status')).toHaveTextContent('The sync folder does not exist.')
    act(() =>
      push(
        status({
          dir: '/mnt/gone',
          state: 'ok',
          lastSync: '2026-09-28T10:00:00.000Z',
          lastConflict: {
            at: '2026-09-28T10:00:00.000Z',
            files: ['settings.conflict-2026-09-28T10-00-00-000Z-box.json'],
          },
        }),
      ),
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'settings.conflict-2026-09-28T10-00-00-000Z-box.json',
    )
  })

  it('stops syncing by clearing the folder', async () => {
    useSettingsStore.setState({ sync: { dir: '/home/me/Sync/pine' } })
    render(<SyncSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Stop syncing' }))
    await waitFor(() => expect(useSettingsStore.getState().sync).toBeUndefined())
    expect(screen.getByText('Not set')).toBeInTheDocument()
  })
})
