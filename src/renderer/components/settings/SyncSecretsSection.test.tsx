import type { SecretSyncStatus, SyncStatus } from '@shared/types'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SyncSecretsSection } from './SyncSecretsSection'

const status = (secrets: SecretSyncStatus['state'], logins = false): SyncStatus => ({
  dir: '/home/me/Sync',
  state: 'ok',
  lastSync: null,
  conflicts: [],
  skipped: [],
  heldBack: [],
  offers: [],
  secrets: { state: secrets, logins },
})

describe('SyncSecretsSection', () => {
  it('turns secret sync on from the switch', async () => {
    const onStatus = vi.fn()
    vi.mocked(window.ostia.sync.secrets.enable).mockResolvedValue({
      ok: true,
      status: status('needs-setup'),
    })
    render(<SyncSecretsSection status={status('off')} onStatus={onStatus} />)
    await userEvent.click(screen.getByRole('switch', { name: 'Sync secrets' }))
    expect(window.ostia.sync.secrets.enable).toHaveBeenCalled()
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(status('needs-setup')))
  })

  it('sets the master password and shows the recovery key once', async () => {
    vi.mocked(window.ostia.sync.secrets.setup).mockResolvedValue({
      ok: true,
      recoveryKey: 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567',
      status: status('unlocked'),
    })
    render(<SyncSecretsSection status={status('needs-setup')} onStatus={() => {}} />)
    await userEvent.type(screen.getByLabelText('New master password'), 'correct horse battery')
    await userEvent.type(screen.getByLabelText('Type it again'), 'correct horse battery')
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(window.ostia.sync.secrets.setup).toHaveBeenCalledWith(
      'correct horse battery',
      'correct horse battery',
    )
    const dialog = await screen.findByRole('alertdialog', { name: 'Save your recovery key' })
    expect(dialog).toHaveTextContent('ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567')
    await userEvent.click(screen.getByRole('button', { name: 'I saved it' }))
    await waitFor(() => expect(screen.queryByText(/ABCD-EFGH/)).toBeNull())
  })

  it('asks for the password when locked and explains a wrong one', async () => {
    vi.mocked(window.ostia.sync.secrets.unlock).mockResolvedValue({
      ok: false,
      error: 'wrong-password',
      status: status('locked'),
    })
    render(<SyncSecretsSection status={status('locked')} onStatus={() => {}} />)
    await userEvent.type(screen.getByLabelText('Master password'), 'not it at all')
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(window.ostia.sync.secrets.unlock).toHaveBeenCalledWith('not it at all')
    expect(await screen.findByText('That is not the master password.')).toBeInTheDocument()
  })

  it('asks before removing the synced secrets', async () => {
    render(<SyncSecretsSection status={status('unlocked')} onStatus={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove synced secrets' }))
    expect(window.ostia.sync.secrets.remove).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove synced secrets?' })
    await userEvent.click(
      Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent === 'Remove synced secrets',
      ) as HTMLElement,
    )
    expect(window.ostia.sync.secrets.remove).toHaveBeenCalled()
  })

  it('offers browser logins only once unlocked, off by default', async () => {
    const { rerender } = render(
      <SyncSecretsSection status={status('locked')} onStatus={() => {}} />,
    )
    expect(screen.queryByRole('switch', { name: 'Browser logins' })).toBeNull()
    rerender(<SyncSecretsSection status={status('unlocked')} onStatus={() => {}} />)
    const logins = screen.getByRole('switch', { name: 'Browser logins' })
    expect(logins).not.toBeChecked()
    await userEvent.click(logins)
    expect(window.ostia.sync.secrets.setLogins).toHaveBeenCalledWith(true)
  })
})
