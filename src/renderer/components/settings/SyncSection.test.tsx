import { useSettingsStore } from '@/stores/app/settingsStore'
import type { SyncStatus } from '@shared/types'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../../test/render'
import { SyncSection } from './SyncSection'

const status = (s: Partial<SyncStatus>): SyncStatus => ({
  dir: null,
  state: 'off',
  lastSync: null,
  conflicts: [],
  skipped: [],
  heldBack: [],
  offers: [],
  secrets: { state: 'off', logins: false },
  ...s,
})

describe('SyncSection', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
  })

  it('shows sync as off with no folder and disables Sync now', async () => {
    await renderSettled(<SyncSection />)
    expect(screen.getByText('Not set')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Off')
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Stop syncing' })).toBeNull()
  })

  it('saves the picked folder into settings.json and syncs right away', async () => {
    const ostia = window.ostia
    vi.mocked(ostia.sync.pickFolder).mockResolvedValue('/home/me/Sync/ostia')
    vi.mocked(ostia.sync.run).mockResolvedValue(
      status({ dir: '/home/me/Sync/ostia', state: 'ok', lastSync: '2026-09-28T10:00:00.000Z' }),
    )
    render(<SyncSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await waitFor(() => expect(ostia.sync.run).toHaveBeenCalled())
    expect(useSettingsStore.getState().sync).toEqual({ dir: '/home/me/Sync/ostia' })
    const written = vi.mocked(ostia.fs.write).mock.calls.at(-1)
    expect(written?.[0]).toBe('/tmp/ostia-test/settings.json')
    expect(JSON.parse(String(written?.[1]))).toMatchObject({ sync: { dir: '/home/me/Sync/ostia' } })
    expect(screen.getByText('/home/me/Sync/ostia')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/^Last synced /)
  })

  it('does nothing when the folder picker is cancelled', async () => {
    render(<SyncSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    expect(window.ostia.sync.run).not.toHaveBeenCalled()
    expect(window.ostia.fs.write).not.toHaveBeenCalled()
  })

  it('explains a missing folder from live status updates', async () => {
    useSettingsStore.setState({ sync: { dir: '/mnt/gone' } })
    let push: (s: SyncStatus) => void = () => {}
    vi.mocked(window.ostia.sync.onStatus).mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    await renderSettled(<SyncSection />)
    act(() => push(status({ dir: '/mnt/gone', state: 'error', error: 'missing' })))
    expect(screen.getByRole('status')).toHaveTextContent('The sync folder does not exist.')
  })

  it('lists a clashed setting with both values and uses the other one on click', async () => {
    useSettingsStore.setState({ sync: { dir: '/home/me/Sync/ostia' } })
    const conflict = {
      id: 'setting:["terminal","fontSize"]',
      kind: 'setting' as const,
      key: 'terminal.fontSize',
      local: '16',
      remote: '14',
      winner: 'local' as const,
    }
    vi.mocked(window.ostia.sync.status).mockResolvedValue(
      status({ dir: '/home/me/Sync/ostia', state: 'ok', conflicts: [conflict] }),
    )
    vi.mocked(window.ostia.sync.resolve).mockResolvedValue(
      status({ dir: '/home/me/Sync/ostia', state: 'ok' }),
    )
    render(<SyncSection />)
    const list = await screen.findByRole('region', { name: 'Changed on both machines' })
    expect(list).toHaveTextContent('terminal.fontSize')
    expect(list).toHaveTextContent('Kept: 16 · Other: 14')
    await userEvent.click(screen.getByRole('button', { name: 'Use the other value' }))
    expect(window.ostia.sync.resolve).toHaveBeenCalledWith(conflict.id)
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Changed on both machines' })).toBeNull(),
    )
  })

  it('shows a secret conflict without values until the human reveals it', async () => {
    useSettingsStore.setState({ sync: { dir: '/home/me/Sync/ostia' } })
    const conflict = {
      id: 'secret:logins\u0000["https://example.com","me"]',
      kind: 'secret' as const,
      key: 'https://example.com (me)',
      local: null,
      remote: null,
      winner: 'local' as const,
      localAt: Date.UTC(2026, 9, 6, 12),
      remoteAt: Date.UTC(2026, 9, 6, 11),
    }
    vi.mocked(window.ostia.sync.status).mockResolvedValue(
      status({ dir: '/home/me/Sync/ostia', state: 'ok', conflicts: [conflict] }),
    )
    vi.mocked(window.ostia.sync.secrets.reveal).mockResolvedValue({
      ok: true,
      local: 'from-b-pass',
      remote: 'from-a-pass',
      winner: 'local',
    })
    render(<SyncSection />)
    const list = await screen.findByRole('region', { name: 'Changed on both machines' })
    expect(list).toHaveTextContent('https://example.com (me)')
    expect(list).toHaveTextContent(/Changed here .* on the other machine /)
    expect(list).not.toHaveTextContent('from-a-pass')
    await userEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    expect(window.ostia.sync.secrets.reveal).toHaveBeenCalledWith(conflict.id)
    expect(list).toHaveTextContent('Kept: from-b-pass · Other: from-a-pass')
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(list).not.toHaveTextContent('from-a-pass')
    await userEvent.click(screen.getByRole('button', { name: 'Use the other value' }))
    expect(window.ostia.sync.resolve).toHaveBeenCalledWith(conflict.id)
  })

  it('offers an extension from another machine and installs it only on click', async () => {
    useSettingsStore.setState({ sync: { dir: '/home/me/Sync/ostia' } })
    const offer = { id: 'trellis', marketplace: 'https://github.com/aurigax-ai/ostia-extensions' }
    vi.mocked(window.ostia.sync.status).mockResolvedValue(
      status({ dir: '/home/me/Sync/ostia', state: 'ok', offers: [offer] }),
    )
    render(<SyncSection />)
    const list = await screen.findByRole('region', { name: 'From your other machines' })
    expect(list).toHaveTextContent('trellis')
    expect(window.ostia.sync.install).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(window.ostia.sync.install).toHaveBeenCalledWith('trellis')
  })

  it('names settings held back as secrets and files left out', async () => {
    useSettingsStore.setState({ sync: { dir: '/home/me/Sync/ostia' } })
    vi.mocked(window.ostia.sync.status).mockResolvedValue(
      status({
        dir: '/home/me/Sync/ostia',
        state: 'ok',
        heldBack: ['browser.homepage'],
        skipped: ['views/linked.json'],
      }),
    )
    render(<SyncSection />)
    expect(await screen.findByText(/looks like a secret: browser\.homepage/)).toBeInTheDocument()
    expect(screen.getByText(/Not synced: views\/linked\.json/)).toBeInTheDocument()
  })

  it('stops syncing by clearing the folder', async () => {
    useSettingsStore.setState({ sync: { dir: '/home/me/Sync/ostia' } })
    render(<SyncSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Stop syncing' }))
    await waitFor(() => expect(useSettingsStore.getState().sync).toBeUndefined())
    expect(screen.getByText('Not set')).toBeInTheDocument()
  })
})
