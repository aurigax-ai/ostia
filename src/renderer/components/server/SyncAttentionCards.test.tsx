import type { SyncAttention } from '@shared/profileSync/serverSync'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSyncAttentionStore } from '@/stores/server/syncAttentionStore'
import { SyncAttentionCards } from './SyncAttentionCards'

const server = () => vi.mocked(window.ostia.server)
const syncServer = () => vi.mocked(window.ostia.syncServer)

const show = (...items: SyncAttention[]): void => {
  useSyncAttentionStore.setState({ items, hidden: new Set() })
  syncServer().attention.mockResolvedValue(items)
}

beforeEach(() => {
  show()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('sync attention cards on Settings › Server', () => {
  it('SYA-C120 warns about a new device with its name and age and clears it on "It is mine"', async () => {
    const user = userEvent.setup()
    show({
      kind: 'new-device',
      id: 'new-device:d2',
      deviceId: 'd2',
      name: 'Laptop',
      createdAt: Date.now() - 180_000,
    })
    server().markSeen.mockResolvedValue({ ok: true })
    render(<SyncAttentionCards />)
    expect(
      screen.getByText(/A new device was added: Laptop \(added 3 minutes ago\)/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'It is mine' }))
    expect(server().markSeen).toHaveBeenCalledWith('d2')
    await waitFor(() => expect(syncServer().attention).toHaveBeenCalled())
  })

  it('SYA-C121 shows how old the asking device is, approves on the click and hides a denied card', async () => {
    const user = userEvent.setup()
    show(
      {
        kind: 'approval',
        id: 'approval:a1',
        approvalId: 'a1',
        name: 'Laptop',
        deviceCreatedAt: Date.now() - 120_000,
        createdAt: Date.now(),
      },
      {
        kind: 'approval',
        id: 'approval:a2',
        approvalId: 'a2',
        name: 'Tablet',
        deviceCreatedAt: Date.now() - 7_200_000,
        createdAt: Date.now(),
      },
    )
    server().approve.mockResolvedValue({ ok: true })
    render(<SyncAttentionCards />)
    expect(screen.getByText(/Laptop asks you to confirm.*added 2 minutes ago/)).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Deny' })[1] as HTMLElement)
    expect(screen.queryByText(/Tablet asks you/)).toBeNull()
    expect(server().approve).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(server().approve).toHaveBeenCalledWith('a1')
  })

  it('SYA-C122 says in plain words that the approving device is too new', async () => {
    const user = userEvent.setup()
    show({
      kind: 'approval',
      id: 'approval:a1',
      approvalId: 'a1',
      name: 'Laptop',
      deviceCreatedAt: 0,
      createdAt: 0,
    })
    server().approve.mockResolvedValue({ ok: false, error: 'device-too-new' })
    render(<SyncAttentionCards />)
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This device joined recently. Approve from an older device.',
    )
  })

  it('SYA-C123 lists a device waiting for the key with its check code and approves it on the click', async () => {
    const user = userEvent.setup()
    show({
      kind: 'join',
      id: 'join:d9',
      deviceId: 'd9',
      name: 'Phone',
      code: 'ABCD-EFGH-JKLM',
      createdAt: Date.now() - 60_000,
    })
    syncServer().approveJoin.mockResolvedValue({ ok: true, status: {} as never })
    render(<SyncAttentionCards />)
    expect(screen.getByText(/Phone wants to join.*ABCD-EFGH-JKLM/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(syncServer().approveJoin).toHaveBeenCalledWith('d9', 'ABCD-EFGH-JKLM')
  })

  it('SYA-C124 warns about devices whose keys changed and renders nothing when nothing is pending', () => {
    show({ kind: 'changed', id: 'changed:Laptop', names: ['Laptop'] })
    const { container } = render(<SyncAttentionCards />)
    expect(screen.getByText(/Laptop: keys or creation date changed/)).toBeInTheDocument()
    cleanup()
    show()
    expect(render(<SyncAttentionCards />).container).toBeEmptyDOMElement()
    expect(container).toBeDefined()
  })
})
