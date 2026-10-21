import type { SyncAttention } from '@shared/profileSync/serverSync'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSyncAttentionStore } from '@/stores/server/syncAttentionStore'
import { SyncRequests } from './SyncRequests'

const syncServer = () => vi.mocked(window.ostia.syncServer)

const join: SyncAttention = {
  kind: 'join',
  id: 'join:d9',
  deviceId: 'd9',
  name: 'Phone',
  code: 'ABCD-EFGH-JKLM',
  createdAt: Date.now() - 60_000,
}

const show = (...items: SyncAttention[]): void => {
  useSyncAttentionStore.setState({ items, hidden: new Set() })
  syncServer().attention.mockResolvedValue(items)
}

beforeEach(() => show())

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('sync requests on Settings › Sync', () => {
  it('SYA-C130 lists a device waiting for the key with its age and check code, and approves it on the click', async () => {
    const user = userEvent.setup()
    show(join)
    syncServer().approveJoin.mockResolvedValue({ ok: true, status: {} as never })
    render(<SyncRequests />)
    expect(screen.getByText('Phone')).toBeInTheDocument()
    expect(screen.getByText('Added 1 minute ago')).toBeInTheDocument()
    expect(screen.getByText('ABCD-EFGH-JKLM')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(syncServer().approveJoin).toHaveBeenCalledWith('d9', 'ABCD-EFGH-JKLM')
    await waitFor(() => expect(syncServer().attention).toHaveBeenCalled())
  })

  it('SYA-C131 shows why an approval failed and hides a denied request', async () => {
    const user = userEvent.setup()
    show(join)
    syncServer().approveJoin.mockResolvedValue({
      ok: false,
      error: 'untrusted',
      status: {} as never,
    })
    render(<SyncRequests />)
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByText(/lists other keys for this device/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(screen.queryByText('Phone')).toBeNull()
  })

  it('SYA-C132 warns in the singular for one changed device and in the plural for several', () => {
    show({ kind: 'changed', id: 'changed:Laptop', names: ['Laptop'] })
    render(<SyncRequests />)
    expect(
      screen.getByText('Laptop: keys or creation date changed. Its sync key is ignored for a day.'),
    ).toBeInTheDocument()
    cleanup()
    show({ kind: 'changed', id: 'changed:Laptop,Phone', names: ['Laptop', 'Phone'] })
    render(<SyncRequests />)
    expect(
      screen.getByText(
        'Laptop, Phone: keys or creation date changed. Their sync keys are ignored for a day.',
      ),
    ).toBeInTheDocument()
  })

  it('SYA-C133 shows nothing when nothing is pending, and ignores other kinds', () => {
    show({
      kind: 'new-device',
      id: 'new-device:d3',
      deviceId: 'd3',
      name: 'build-box',
      createdAt: 0,
    })
    expect(render(<SyncRequests />).container).toBeEmptyDOMElement()
  })
})
