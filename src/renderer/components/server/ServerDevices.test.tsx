import type { ServerSyncStatus, SyncAttention } from '@shared/profileSync/serverSync'
import type { ServerDevice } from '@shared/server/serverApi'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSyncAttentionStore } from '@/stores/server/syncAttentionStore'
import { ServerDevices } from './ServerDevices'
import { useServerDevices } from './useServerDevices'

function Devices({ onLeave }: { onLeave: () => void }): JSX.Element {
  return <ServerDevices state={useServerDevices()} onLeave={onLeave} />
}

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
  lastSeenAt: 0,
  removeAt: 0,
  createdAt: Date.now() - 3_600_000,
  ...over,
})

const server = () => vi.mocked(window.ostia.server)
const syncServer = () => vi.mocked(window.ostia.syncServer)

beforeEach(() => {
  useSyncAttentionStore.setState({ items: [], hidden: new Set() })
  server().devices.mockResolvedValue({ ok: true, devices: [device({})] })
  syncServer().status.mockResolvedValue(SYNC)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('shared device list', () => {
  it('SYA-C120 lists each device with its age, marks this computer and offers Remove on every row', async () => {
    server().devices.mockResolvedValue({
      ok: true,
      devices: [
        device({ createdAt: Date.now() - 2 * 86_400_000 }),
        device({ id: 'd2', name: 'Laptop', current: false, createdAt: Date.now() - 180_000 }),
      ],
    })
    render(<Devices onLeave={() => {}} />)
    expect(await screen.findByText('This computer')).toBeInTheDocument()
    expect(screen.getByText('Added 3 minutes ago')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2)
  })

  it('SYA-C124 marks a device whose keys changed on its own row, with Remove and no warning text', async () => {
    const until = Date.UTC(2026, 9, 22, 14, 30)
    server().devices.mockResolvedValue({
      ok: true,
      devices: [device({}), device({ id: 'd2', name: 'Laptop', current: false })],
    })
    useSyncAttentionStore.setState({
      items: [
        { kind: 'changed', id: `changed:d2:${until}`, deviceId: 'd2', name: 'Laptop', until },
      ],
    })
    render(<Devices onLeave={() => {}} />)
    expect(await screen.findByText('Changed')).toBeInTheDocument()
    expect(
      screen.getByText(
        `Keys changed · sync key ignored until ${new Intl.DateTimeFormat('en', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(until)}`,
      ),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2)
  })

  it("SYA-C125 asks the section to leave the server from this computer's row", async () => {
    const user = userEvent.setup()
    const onLeave = vi.fn()
    render(<Devices onLeave={onLeave} />)
    await user.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(server().signOut).not.toHaveBeenCalled()
  })

  it('SYA-C126 shows an approval whose device is not in the list as its own row with the name it carries', async () => {
    server().devices.mockResolvedValue({ ok: true, devices: [device({})] })
    useSyncAttentionStore.setState({
      items: [
        {
          kind: 'approval',
          id: 'approval:a1',
          approvalId: 'a1',
          deviceId: 'gone',
          name: 'Studio laptop',
          createdAt: 0,
        },
      ],
    })
    render(<Devices onLeave={() => {}} />)
    expect(await screen.findByText('Studio laptop')).toBeInTheDocument()
    expect(screen.getByText('Asks to confirm a change')).toBeInTheDocument()
    expect(screen.getByText('Approve only if you made this change.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('SYA-C127 says when a silent device is removed once that is within 14 days, and never for this computer', async () => {
    const day = 86_400_000
    const removeAt = Date.now() + 5 * day
    server().devices.mockResolvedValue({
      ok: true,
      devices: [
        device({ removeAt }),
        device({ id: 'd2', name: 'Laptop', current: false, removeAt }),
        device({ id: 'd3', name: 'Tablet', current: false, removeAt: Date.now() + 60 * day }),
      ],
    })
    render(<Devices onLeave={() => {}} />)
    const when = new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(removeAt)
    expect(await screen.findByText(`Removed ${when} unless it checks in`)).toBeInTheDocument()
    expect(screen.getAllByText(/unless it checks in/)).toHaveLength(1)
  })

  it('SYA-C122 gives the device asking for a confirmation Approve and Deny in place of Remove', async () => {
    const user = userEvent.setup()
    server().devices.mockResolvedValue({
      ok: true,
      devices: [
        device({}),
        device({ id: 'd2', name: 'Laptop', current: false, createdAt: Date.now() - 120_000 }),
        device({ id: 'd3', name: 'Tablet', current: false }),
      ],
    })
    server().approve.mockResolvedValue({ ok: true })
    const items: SyncAttention[] = [
      {
        kind: 'approval',
        id: 'approval:a1',
        approvalId: 'a1',
        deviceId: 'd2',
        name: 'Laptop',
        createdAt: Date.now(),
      },
    ]
    useSyncAttentionStore.setState({ items })
    syncServer().attention.mockResolvedValue(items)
    render(<Devices onLeave={() => {}} />)
    expect(
      await screen.findByText('Asks to confirm a change · added 2 minutes ago'),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(server().approve).toHaveBeenCalledWith('a1')
    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(3)
  })

  it('SYA-C123 says in plain words that the approving device is too new', async () => {
    const user = userEvent.setup()
    server().devices.mockResolvedValue({
      ok: true,
      devices: [device({}), device({ id: 'd2', name: 'Laptop', current: false })],
    })
    server().approve.mockResolvedValue({ ok: false, error: 'device-too-new' })
    const items: SyncAttention[] = [
      {
        kind: 'approval',
        id: 'approval:a1',
        approvalId: 'a1',
        deviceId: 'd2',
        name: 'Laptop',
        createdAt: 0,
      },
    ]
    useSyncAttentionStore.setState({ items })
    syncServer().attention.mockResolvedValue(items)
    render(<Devices onLeave={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(await screen.findByText(/This device joined recently/)).toBeInTheDocument()
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
    render(<Devices onLeave={() => {}} />)
    await user.click((await screen.findAllByRole('button', { name: 'Remove' }))[1] as HTMLElement)
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
    render(<Devices onLeave={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Make a code' }))
    expect(await screen.findByText('ABCD-1234')).toBeInTheDocument()
    expect(screen.getByText('Waiting for the new device to sign in.')).toBeInTheDocument()
  })
})
