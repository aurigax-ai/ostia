import type { ServerSyncStatus } from '@shared/profileSync/serverSync'
import type { ServerStatus } from '@shared/server/serverApi'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/stores/app/uiStore'
import { SyncServerSection } from './SyncServerSection'

const SIGNED_IN: ServerStatus = {
  url: 'https://ostia.example.com',
  host: 'ostia.example.com',
  signedIn: true,
  provider: 'invite',
  deviceName: 'Desk',
}

const status = (over: Partial<ServerSyncStatus>): ServerSyncStatus => ({
  state: 'ready',
  host: 'ostia.example.com',
  linking: false,
  linkApproved: false,
  linkCodes: [],
  joins: [],
  recoveryStale: false,
  wrapRefused: null,
  changedDevices: [],
  ...over,
})

const api = () => vi.mocked(window.ostia.syncServer)

beforeEach(() => {
  vi.mocked(window.ostia.server.status).mockResolvedValue(SIGNED_IN)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings › Sync › Server', () => {
  it('SSY-C90 sends a signed-out computer to Settings › Server', async () => {
    vi.mocked(window.ostia.server.status).mockResolvedValue({ ...SIGNED_IN, signedIn: false })
    const user = userEvent.setup()
    render(<SyncServerSection onChanged={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Open Settings › Server' }))
    expect(useUIStore.getState().settingsSection).toBe('server')
  })

  it('SSY-C91 sets a passphrase once and shows the recovery key once', async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    api().status.mockResolvedValue(status({ state: 'needs-setup' }))
    api().setup.mockResolvedValue({
      ok: true,
      recoveryKey: 'AAAA-BBBB-CCCC',
      status: status({}),
    })
    render(<SyncServerSection onChanged={onChanged} />)
    await user.type(await screen.findByPlaceholderText('New sync passphrase'), 'a long passphrase')
    await user.type(screen.getByPlaceholderText('Type it again'), 'a long passphrase')
    await user.click(screen.getByRole('button', { name: 'Turn on sync' }))
    expect(api().setup).toHaveBeenCalledWith('a long passphrase', 'a long passphrase')
    expect(await screen.findByText('AAAA-BBBB-CCCC')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'I saved it' }))
    expect(screen.queryByText('AAAA-BBBB-CCCC')).toBeNull()
    expect(onChanged).toHaveBeenCalled()
  })

  it('SSY-C92 unlocks with the passphrase and explains a wrong one', async () => {
    const user = userEvent.setup()
    api().status.mockResolvedValue(status({ state: 'locked' }))
    api().unlock.mockResolvedValue({
      ok: false,
      error: 'wrong-password',
      status: status({ state: 'locked' }),
    })
    render(<SyncServerSection onChanged={() => {}} />)
    await user.type(await screen.findByPlaceholderText('Sync passphrase'), 'nope{Enter}')
    expect(api().unlock).toHaveBeenCalledWith('nope')
    expect(await screen.findByText('That is not the sync passphrase.')).toBeInTheDocument()
  })

  it('SSY-C93 unlocks with the recovery key', async () => {
    const user = userEvent.setup()
    api().status.mockResolvedValue(status({ state: 'locked' }))
    render(<SyncServerSection onChanged={() => {}} />)
    await user.type(await screen.findByPlaceholderText('Recovery key'), 'AAAA-BBBB{Enter}')
    expect(api().recover).toHaveBeenCalledWith('AAAA-BBBB')
  })

  it('SSY-C94 waits for an approval and shows the check code per device', async () => {
    const user = userEvent.setup()
    api().status.mockResolvedValue(status({ state: 'locked' }))
    api().linkStart.mockResolvedValue({
      ok: true,
      status: status({
        state: 'locked',
        linking: true,
        linkCodes: [{ deviceName: 'Desk', code: 'ABCD-EFGH-JKLM' }],
      }),
    })
    render(<SyncServerSection onChanged={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Approve from another device' }))
    expect(await screen.findByText('Desk: ABCD-EFGH-JKLM')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop waiting' })).toBeInTheDocument()
  })

  it('SSY-C95 offers a new recovery key when the old one stopped working and cleans up after approval', async () => {
    const user = userEvent.setup()
    api().status.mockResolvedValue(status({ recoveryStale: true }))
    api().newRecoveryKey.mockResolvedValue({
      ok: true,
      recoveryKey: 'NEWK-NEWK',
      status: status({}),
    })
    api()
      .collectGarbage.mockResolvedValueOnce({
        ok: false,
        error: 'elevation-required',
        status: status({}),
      })
      .mockResolvedValueOnce({ ok: true, deleted: 4, status: status({}) })
    vi.mocked(window.ostia.server.elevationPoll).mockResolvedValue({ state: 'done' })
    render(<SyncServerSection onChanged={() => {}} />)
    expect(
      await screen.findByText('The old recovery key no longer opens new data.'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Make a new recovery key' }))
    expect(await screen.findByText('NEWK-NEWK')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'I saved it' }))
    await user.click(screen.getByRole('button', { name: 'Clean up' }))
    expect(await screen.findByText('Removed 4 items.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(api().collectGarbage).toHaveBeenCalledTimes(2)
  })

  it('SSY-C96 asks the human to confirm the code once approved, and shows a paused sync for a mismatch', async () => {
    const user = userEvent.setup()
    api().status.mockResolvedValue(
      status({
        state: 'locked',
        linking: true,
        linkApproved: true,
        linkCodes: [{ deviceName: 'Desk', code: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE' }],
      }),
    )
    api().linkConfirm.mockResolvedValue({ ok: true, status: status({}) })
    const view = render(<SyncServerSection onChanged={() => {}} />)
    expect(await screen.findByText(/Confirm only if the code above matches/)).toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: 'The code AAAAA-BBBBB-CCCCC-DDDDD-EEEEE matches' }),
    )
    expect(api().linkConfirm).toHaveBeenCalledWith('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE')
    view.unmount()
    api().status.mockResolvedValue(status({ state: 'untrusted' }))
    render(<SyncServerSection onChanged={() => {}} />)
    expect(await screen.findByText(/lists other keys for this device/)).toBeInTheDocument()
  })

  it('SSY-C97 warns when a new sync key from another device was ignored and offers no action', async () => {
    api().status.mockResolvedValue(
      status({ state: 'ready', wrapRefused: { reason: 'untrusted', after: null } }),
    )
    render(<SyncServerSection onChanged={() => {}} />)
    expect(await screen.findByText(/was not signed by a device you trust/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Sync passphrase')).toBeNull()
  })

  it('SSY-C165 says the signer is too new, until when, and offers the passphrase', async () => {
    const user = userEvent.setup()
    api().status.mockResolvedValue(
      status({ state: 'ready', wrapRefused: { reason: 'too-new', after: Date.UTC(2026, 9, 7) } }),
    )
    render(<SyncServerSection onChanged={() => {}} />)
    api().unlock.mockResolvedValue({ ok: true, status: status({ state: 'ready' }) })
    expect(await screen.findByText(/too new to trust yet/)).toBeInTheDocument()
    expect(screen.queryByText(/was not signed by a device you trust/)).toBeNull()
    await user.type(screen.getByLabelText('Sync passphrase'), 'a long passphrase')
    await user.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(api().unlock).toHaveBeenCalledWith('a long passphrase')
  })

  it('SSY-C167 explains a stale link instead of the recovery key message', async () => {
    const user = userEvent.setup()
    api().status.mockResolvedValue(
      status({
        state: 'locked',
        linking: true,
        linkApproved: true,
        linkCodes: [{ deviceName: 'Desk', code: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE' }],
      }),
    )
    api().linkConfirm.mockResolvedValue({
      ok: false,
      error: 'link-stale',
      status: status({ state: 'locked' }),
    })
    render(<SyncServerSection onChanged={() => {}} />)
    await user.click(
      await screen.findByRole('button', { name: 'The code AAAAA-BBBBB-CCCCC-DDDDD-EEEEE matches' }),
    )
    expect(await screen.findByText(/Another device synced in between/)).toBeInTheDocument()
    expect(screen.queryByText(/no recovery key/)).toBeNull()
  })
})
