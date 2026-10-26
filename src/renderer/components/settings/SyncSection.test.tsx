import type { SyncStatus } from '@shared/profileSync/profileSync'
import type { ServerSyncStatus } from '@shared/profileSync/serverSync'
import type { ServerStatus } from '@shared/server/serverApi'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { renderSettled } from '../../../../test/render'
import { SyncSection } from './SyncSection'

const status = (s: Partial<SyncStatus>): SyncStatus => ({
  dir: null,
  state: 'off',
  lastSync: null,
  skipped: [],
  heldBack: [],
  secrets: { state: 'off', mode: 'password', logins: false },
  ...s,
})

const SIGNED_IN: ServerStatus = {
  url: 'https://ostia.example.com',
  host: 'ostia.example.com',
  signedIn: true,
  provider: 'github',
  deviceName: 'desk',
}

const serverSync = (state: ServerSyncStatus['state']): ServerSyncStatus => ({
  state,
  host: 'ostia.example.com',
})

function onServer(account: ServerStatus, state: ServerSyncStatus['state'] = 'ready'): void {
  useSettingsStore.setState({ sync: { dir: '', method: 'server' } })
  vi.mocked(window.ostia.server.status).mockResolvedValue(account)
  vi.mocked(window.ostia.server.info).mockResolvedValue({
    ok: true,
    offer: { relay: true, publish: true, sync: true, push: true, invite: true, github: true },
  })
  vi.mocked(window.ostia.syncServer.status).mockResolvedValue(serverSync(state))
}

describe('Settings › Sync', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
  })

  it('SYV-C1 shows only the sync method while sync is off', async () => {
    await renderSettled(<SyncSection />)
    expect(screen.getByRole('combobox', { name: 'Sync method' })).toHaveTextContent('Off')
    expect(screen.queryByText('Status')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull()
    expect(screen.queryByText('Ostia account')).toBeNull()
  })

  it('SYV-C2 picks a folder when Folder is chosen and stays off when the picker is cancelled', async () => {
    const ostia = window.ostia
    const user = userEvent.setup()
    render(<SyncSection />)
    await user.click(screen.getByRole('combobox', { name: 'Sync method' }))
    await user.click(await screen.findByRole('option', { name: 'Folder' }))
    expect(ostia.sync.pickFolder).toHaveBeenCalledTimes(1)
    expect(ostia.sync.run).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox', { name: 'Sync method' })).toHaveTextContent('Off')

    vi.mocked(ostia.sync.pickFolder).mockResolvedValue('/home/me/Sync/ostia')
    vi.mocked(ostia.sync.run).mockResolvedValue(
      status({ dir: '/home/me/Sync/ostia', state: 'ok', lastSync: '2026-09-28T10:00:00.000Z' }),
    )
    await user.click(screen.getByRole('combobox', { name: 'Sync method' }))
    await user.click(await screen.findByRole('option', { name: 'Folder' }))
    await waitFor(() => expect(ostia.sync.run).toHaveBeenCalled())
    expect(useSettingsStore.getState().sync).toEqual({ dir: '/home/me/Sync/ostia' })
    expect(screen.getByText('/home/me/Sync/ostia')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument()
    expect(screen.getByText(/^Last synced /)).toBeInTheDocument()
  })

  it('SYV-C3 signed out offers GitHub, with the invite code and server address behind links', async () => {
    onServer({ ...SIGNED_IN, signedIn: false, provider: null, deviceName: null })
    const user = userEvent.setup()
    await renderSettled(<SyncSection />)
    expect(screen.getByText('Sign in to sync through ostia.example.com.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Invite code' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Server address' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Use an invite code' }))
    expect(screen.getByRole('textbox', { name: 'Invite code' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Change server' }))
    expect(screen.getByRole('textbox', { name: 'Server address' })).toBeInTheDocument()
    expect(screen.queryByText('Status')).toBeNull()
  })

  it('SYV-C4 asks for a new passphrase on its own on a new account and shows the recovery key once', async () => {
    onServer(SIGNED_IN, 'needs-setup')
    vi.mocked(window.ostia.syncServer.setup).mockResolvedValue({
      ok: true,
      recoveryKey: 'ABCD-EFGH-IJKL-MNOP',
      status: serverSync('ready'),
    })
    const user = userEvent.setup()
    await renderSettled(<SyncSection />)
    const dialog = await screen.findByRole('dialog', { name: 'Create a sync passphrase' })
    await user.type(within(dialog).getByLabelText('Sync passphrase'), 'a long sync passphrase')
    await user.type(within(dialog).getByLabelText('Type it again'), 'a long sync passphrase')
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    expect(window.ostia.syncServer.setup).toHaveBeenCalledWith(
      'a long sync passphrase',
      'a long sync passphrase',
    )
    const saved = await screen.findByRole('dialog', { name: 'Save your recovery key' })
    expect(within(saved).getByText('ABCD-EFGH-IJKL-MNOP')).toBeInTheDocument()
    await user.click(within(saved).getByRole('button', { name: 'I saved it' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument()
  })

  it('SYV-C5 asks once for the passphrase on a joining computer, with the recovery key as a way out', async () => {
    onServer(SIGNED_IN, 'locked')
    const user = userEvent.setup()
    await renderSettled(<SyncSection />)
    const dialog = await screen.findByRole('dialog', { name: 'Enter your sync passphrase' })
    await user.click(within(dialog).getByRole('button', { name: 'Later' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('Waiting for the sync passphrase')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Enter passphrase' }))
    const again = await screen.findByRole('dialog', { name: 'Enter your sync passphrase' })
    await user.type(within(again).getByLabelText('Sync passphrase'), 'typed then gave up')
    await user.click(within(again).getByRole('button', { name: 'Use recovery key' }))
    expect(window.ostia.syncServer.unlock).not.toHaveBeenCalled()
    const recover = await screen.findByRole('dialog', { name: 'Use your recovery key' })
    await user.type(within(recover).getByLabelText('Recovery key'), 'ABCD-EFGH')
    await user.type(within(recover).getByLabelText('New sync passphrase'), 'a new sync passphrase')
    await user.type(within(recover).getByLabelText('Type it again'), 'a new sync passphrase')
    await user.click(within(recover).getByRole('button', { name: 'Continue' }))
    expect(window.ostia.syncServer.recover).toHaveBeenCalledWith(
      'ABCD-EFGH',
      'a new sync passphrase',
      'a new sync passphrase',
    )
  })

  it('SYV-C6 shows a wrong passphrase inside the popup', async () => {
    onServer(SIGNED_IN, 'locked')
    vi.mocked(window.ostia.syncServer.unlock).mockResolvedValue({
      ok: false,
      error: 'wrong-password',
      status: serverSync('locked'),
    })
    const user = userEvent.setup()
    await renderSettled(<SyncSection />)
    const dialog = await screen.findByRole('dialog', { name: 'Enter your sync passphrase' })
    await user.type(within(dialog).getByLabelText('Sync passphrase'), 'not it at all')
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That is not the sync passphrase.',
    )
  })

  it('SYV-C7 shows the account, the server address and Change passphrase, and nothing about devices', async () => {
    onServer(SIGNED_IN)
    vi.mocked(window.ostia.syncServer.changePassphrase).mockResolvedValue({
      ok: true,
      recoveryKey: 'WXYZ-2345',
      status: serverSync('ready'),
    })
    const user = userEvent.setup()
    await renderSettled(<SyncSection />)
    expect(await screen.findByText('Signed in as desk with GitHub.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    expect(screen.getByText('https://ostia.example.com')).toBeInTheDocument()
    for (const gone of [/Devices/, /Add device/, /Changed on both/, /other machines/]) {
      expect(screen.queryByText(gone)).toBeNull()
    }
    await user.click(screen.getByRole('button', { name: 'Change passphrase' }))
    const dialog = await screen.findByRole('dialog', { name: 'Change sync passphrase' })
    await user.type(within(dialog).getByLabelText('Current passphrase'), 'the old passphrase')
    await user.type(within(dialog).getByLabelText('New sync passphrase'), 'the new passphrase')
    await user.type(within(dialog).getByLabelText('Type it again'), 'the new passphrase')
    await user.click(within(dialog).getByRole('button', { name: 'Change passphrase' }))
    expect(window.ostia.syncServer.changePassphrase).toHaveBeenCalledWith(
      'the old passphrase',
      'the new passphrase',
      'the new passphrase',
    )
    expect(await screen.findByText('WXYZ-2345')).toBeInTheDocument()
  })

  it('SYV-C9 a Sign in link shows the account without turning sync on', async () => {
    vi.mocked(window.ostia.server.status).mockResolvedValue({
      ...SIGNED_IN,
      signedIn: false,
      provider: null,
      deviceName: null,
    })
    vi.mocked(window.ostia.server.info).mockResolvedValue({
      ok: true,
      offer: { relay: true, publish: true, sync: true, push: true, invite: true, github: true },
    })
    useUIStore.getState().openSettings('sync', { signIn: true })
    await renderSettled(<SyncSection />)
    expect(screen.getByRole('combobox', { name: 'Sync method' })).toHaveTextContent('Off')
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument()
    expect(window.ostia.sync.run).not.toHaveBeenCalled()
    act(() => useUIStore.getState().openSettings('sync'))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Sign in with GitHub' })).toBeNull(),
    )
  })

  it('SYV-C8 explains a missing folder from live status updates', async () => {
    useSettingsStore.setState({ sync: { dir: '/mnt/gone' } })
    let push: (s: SyncStatus) => void = () => {}
    vi.mocked(window.ostia.sync.onStatus).mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    await renderSettled(<SyncSection />)
    act(() => push(status({ dir: '/mnt/gone', state: 'error', error: 'missing' })))
    expect(screen.getByRole('alert')).toHaveTextContent('The sync folder does not exist.')
  })
})
