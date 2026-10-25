import type { SecretSyncStatus, SyncStatus } from '@shared/profileSync/profileSync'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SyncSecretsSection } from './SyncSecretsSection'

const status = (
  state: SecretSyncStatus['state'],
  mode: SecretSyncStatus['mode'] = 'password',
): SyncStatus => ({
  dir: '/home/me/Sync',
  state: 'ok',
  lastSync: null,
  skipped: [],
  heldBack: [],
  secrets: { state, mode, logins: false },
})

describe('SyncSecretsSection', () => {
  it('SYV-C10 on the server method turns on with the sync passphrase and asks for nothing', async () => {
    const onStatus = vi.fn()
    vi.mocked(window.ostia.sync.secrets.enable).mockResolvedValue({
      ok: true,
      status: status('unlocked', 'sync-key'),
    })
    render(<SyncSecretsSection status={status('off', 'sync-key')} server onStatus={onStatus} />)
    expect(screen.getByText(/Encrypted with your sync passphrase\./)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('switch', { name: 'Sync secrets' }))
    expect(window.ostia.sync.secrets.enable).toHaveBeenCalled()
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(status('unlocked', 'sync-key')))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('SYV-C11 sets a separate password from the link and shows its recovery key once', async () => {
    vi.mocked(window.ostia.sync.secrets.reset).mockResolvedValue({
      ok: true,
      recoveryKey: 'ABCD-EFGH-IJKL-MNOP',
      status: status('unlocked'),
    })
    const user = userEvent.setup()
    render(
      <SyncSecretsSection status={status('unlocked', 'sync-key')} server onStatus={() => {}} />,
    )
    await user.click(screen.getByRole('button', { name: 'Use a separate password' }))
    const dialog = await screen.findByRole('dialog', { name: 'Use a separate secrets password' })
    await user.type(within(dialog).getByLabelText('New secrets password'), 'correct horse battery')
    await user.type(within(dialog).getByLabelText('Type it again'), 'correct horse battery')
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    expect(window.ostia.sync.secrets.reset).toHaveBeenCalledWith(
      'correct horse battery',
      'correct horse battery',
    )
    expect(await screen.findByText('ABCD-EFGH-IJKL-MNOP')).toBeInTheDocument()
  })

  it('SYV-C12 goes back to the sync passphrase from a separate password', async () => {
    render(<SyncSecretsSection status={status('unlocked')} server onStatus={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Use the sync passphrase' }))
    expect(window.ostia.sync.secrets.useSyncKey).toHaveBeenCalled()
  })

  it('SYV-C13 on a folder asks for a new password when turned on', async () => {
    vi.mocked(window.ostia.sync.secrets.enable).mockResolvedValue({
      ok: true,
      status: status('needs-setup'),
    })
    render(<SyncSecretsSection status={status('off')} server={false} onStatus={() => {}} />)
    expect(screen.getByText(/Encrypted with a secrets password\./)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('switch', { name: 'Sync secrets' }))
    expect(
      await screen.findByRole('dialog', { name: 'Set a secrets password' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use the sync passphrase' })).toBeNull()
  })

  it('SYV-C14 asks for the secrets password when locked and explains a wrong one', async () => {
    vi.mocked(window.ostia.sync.secrets.unlock).mockResolvedValue({
      ok: false,
      error: 'wrong-password',
      status: status('locked'),
    })
    const user = userEvent.setup()
    render(<SyncSecretsSection status={status('locked')} server={false} onStatus={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Enter password' }))
    const dialog = await screen.findByRole('dialog', { name: 'Enter your secrets password' })
    await user.type(within(dialog).getByLabelText('Secrets password'), 'not it at all')
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    expect(window.ostia.sync.secrets.unlock).toHaveBeenCalledWith('not it at all')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That is not the secrets password.',
    )
  })
})
