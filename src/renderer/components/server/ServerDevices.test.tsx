import type { ServerSyncStatus } from '@shared/profileSync/serverSync'
import type { ServerDevice } from '@shared/server/serverApi'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServerDevices } from './ServerDevices'

const SYNC: ServerSyncStatus = {
  state: 'ready',
  host: 'ostia.example.com',
  linking: false,
  linkApproved: false,
  linkCodes: [],
  joins: [],
  recoveryStale: false,
  wrapRefused: null,
  changedDevices: [],
}

const device = (over: Partial<ServerDevice>): ServerDevice => ({
  id: 'd1',
  name: 'Desk',
  current: true,
  lastSeen: 0,
  createdAt: Date.now() - 3_600_000,
  isNew: false,
  ...over,
})

const server = () => vi.mocked(window.ostia.server)
const syncServer = () => vi.mocked(window.ostia.syncServer)

beforeEach(() => {
  server().devices.mockResolvedValue({ ok: true, devices: [device({})] })
  syncServer().status.mockResolvedValue(SYNC)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('shared device list', () => {
  it('SSY-C85 asks another device when removing needs a confirmation and retries once it approved', async () => {
    const user = userEvent.setup()
    server().devices.mockResolvedValue({
      ok: true,
      devices: [device({}), device({ id: 'd2', name: 'Laptop', current: false })],
    })
    syncServer()
      .removeDevice.mockResolvedValueOnce({ ok: false, error: 'elevation-required', status: SYNC })
      .mockResolvedValueOnce({ ok: true, removed: true, rotated: true, status: SYNC })
    server().elevationPoll.mockResolvedValue({ state: 'done' })
    render(<ServerDevices />)
    await user.click(await screen.findByRole('button', { name: 'Remove' }))
    await user.type(screen.getByLabelText('Sync passphrase'), 'a long passphrase')
    await user.click(screen.getByRole('button', { name: 'Remove device' }))
    await waitFor(() => expect(syncServer().removeDevice).toHaveBeenCalledTimes(2), {
      timeout: 5000,
    })
    expect(server().elevationStart).toHaveBeenCalledWith('approval')
    expect(syncServer().removeDevice).toHaveBeenLastCalledWith('d2', 'a long passphrase', '')
    expect(
      await screen.findByText('The device was removed and the sync key was changed.'),
    ).toBeInTheDocument()
  })

  it('SSY-C86 makes a one-time code for a new device', async () => {
    const user = userEvent.setup()
    server().createInvite.mockResolvedValue({ ok: true, code: 'ABCD-1234', expiresAt: 0 })
    render(<ServerDevices />)
    await user.click(await screen.findByRole('button', { name: 'Make a code' }))
    expect(await screen.findByText('ABCD-1234')).toBeInTheDocument()
    expect(screen.getByText('Waiting for the new device to sign in.')).toBeInTheDocument()
  })
})
