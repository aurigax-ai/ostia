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

describe('shared device list, warnings and approval cards', () => {
  it('SSY-C81 warns about a new device with its name and age and clears it on "It is mine"', async () => {
    const user = userEvent.setup()
    server().devices.mockResolvedValue({
      ok: true,
      devices: [
        device({}),
        device({
          id: 'd2',
          name: 'Laptop',
          current: false,
          isNew: true,
          createdAt: Date.now() - 180_000,
        }),
      ],
    })
    render(<ServerDevices />)
    expect(
      await screen.findByText(/A new device was added: Laptop \(added 3 minutes ago\)/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'It is mine' }))
    expect(server().markSeen).toHaveBeenCalledWith('d2')
  })

  it('SSY-C82 shows who asks and how old the device is, approves on the click and hides a denied card', async () => {
    const user = userEvent.setup()
    server().approvals.mockResolvedValue({
      ok: true,
      approvals: [
        {
          id: 'a1',
          deviceName: 'Laptop',
          deviceCreatedAt: Date.now() - 120_000,
          createdAt: Date.now(),
          expiresAt: Date.now() + 300_000,
        },
        {
          id: 'a2',
          deviceName: 'Tablet',
          deviceCreatedAt: Date.now() - 7_200_000,
          createdAt: Date.now(),
          expiresAt: Date.now() + 300_000,
        },
      ],
    })
    render(<ServerDevices />)
    expect(
      await screen.findByText(/Laptop asks you to confirm.*added 2 minutes ago/),
    ).toBeInTheDocument()
    const denies = screen.getAllByRole('button', { name: 'Deny' })
    await user.click(denies[1] as HTMLElement)
    expect(screen.queryByText(/Tablet asks you/)).toBeNull()
    expect(server().approve).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(server().approve).toHaveBeenCalledWith('a1')
  })

  it('SSY-C83 says in plain words that the approving device is too new', async () => {
    const user = userEvent.setup()
    server().approvals.mockResolvedValue({
      ok: true,
      approvals: [
        { id: 'a1', deviceName: 'Laptop', deviceCreatedAt: 0, createdAt: 0, expiresAt: 1 },
      ],
    })
    server().approve.mockResolvedValue({ ok: false, error: 'device-too-new' })
    render(<ServerDevices />)
    await user.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This device joined recently. Approve from an older device.',
    )
  })

  it('SSY-C84 lists a device waiting for the key with its check code and approves it on the click', async () => {
    const user = userEvent.setup()
    syncServer().status.mockResolvedValue({
      ...SYNC,
      joins: [
        { deviceId: 'd9', name: 'Phone', code: 'ABCD-EFGH-JKLM', createdAt: Date.now() - 60_000 },
      ],
    })
    syncServer().approveJoin.mockResolvedValue({ ok: true, status: SYNC })
    render(<ServerDevices />)
    expect(await screen.findByText(/Phone wants to join.*ABCD-EFGH-JKLM/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(syncServer().approveJoin).toHaveBeenCalledWith('d9', 'ABCD-EFGH-JKLM')
  })

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
