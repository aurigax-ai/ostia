import type { SyncAttention } from '@shared/profileSync/serverSync'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/stores/app/uiStore'
import { useSyncAttentionStore } from '@/stores/server/syncAttentionStore'
import { SyncAttentionCard } from './SyncAttentionCard'

const join: SyncAttention = {
  kind: 'join',
  id: 'join:d2',
  deviceId: 'd2',
  name: 'Phone',
  code: 'AAAAA-BBBBB',
  createdAt: Date.now() - 60_000,
}

const syncServer = () => vi.mocked(window.ostia.syncServer)
const server = () => vi.mocked(window.ostia.server)

beforeEach(() => {
  useSyncAttentionStore.setState({ items: [], seenAt: {}, hidden: new Set() })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SyncAttentionCard', () => {
  it('SYA-C120 approves a join request with the code shown, then refreshes the list', async () => {
    syncServer().approveJoin.mockResolvedValue({ ok: true, status: {} as never })
    render(<SyncAttentionCard item={join} at={join.createdAt} />)
    expect(screen.getByText(/Phone wants to join/)).toBeTruthy()
    expect(screen.getByText(/AAAAA-BBBBB/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(syncServer().approveJoin).toHaveBeenCalledWith('d2', 'AAAAA-BBBBB')
    await waitFor(() => expect(syncServer().attention).toHaveBeenCalled())
  })

  it('SYA-C121 shows the error when approving fails', async () => {
    syncServer().approveJoin.mockResolvedValue({
      ok: false,
      error: 'untrusted',
      status: {} as never,
    })
    render(<SyncAttentionCard item={join} at={join.createdAt} />)
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByText(/different|not|untrusted|server/i)).toBeTruthy()
  })

  it('SYA-C122 hides a denied request without calling the server', async () => {
    render(<SyncAttentionCard item={join} at={join.createdAt} />)
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(useSyncAttentionStore.getState().hidden.has('join:d2')).toBe(true)
    expect(syncServer().approveJoin).not.toHaveBeenCalled()
  })

  it('SYA-C123 acknowledges a new device with the signed seen action', async () => {
    server().markSeen.mockResolvedValue({ ok: true })
    const item: SyncAttention = {
      kind: 'new-device',
      id: 'new-device:d9',
      deviceId: 'd9',
      name: 'Unknown',
      createdAt: Date.now(),
    }
    render(<SyncAttentionCard item={item} at={item.createdAt} />)
    await userEvent.click(screen.getByRole('button', { name: 'It is mine' }))
    expect(server().markSeen).toHaveBeenCalledWith('d9')
    await waitFor(() => expect(syncServer().attention).toHaveBeenCalled())
  })

  it('SYA-C124 approves an elevation request and opens settings for a changed device', async () => {
    server().approve.mockResolvedValue({ ok: true })
    const ask: SyncAttention = {
      kind: 'approval',
      id: 'approval:a1',
      approvalId: 'a1',
      name: 'Watch',
      deviceCreatedAt: Date.now(),
      createdAt: Date.now(),
    }
    render(<SyncAttentionCard item={ask} at={ask.createdAt} />)
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(server().approve).toHaveBeenCalledWith('a1')
    cleanup()
    const openSettings = vi.spyOn(useUIStore.getState(), 'openSettings')
    useUIStore.setState({ openSettings })
    render(
      <SyncAttentionCard
        item={{ kind: 'changed', id: 'changed:Laptop', names: ['Laptop'] }}
        at={Date.now()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /Settings › Server/ }))
    expect(openSettings).toHaveBeenCalledWith('server')
  })
})
