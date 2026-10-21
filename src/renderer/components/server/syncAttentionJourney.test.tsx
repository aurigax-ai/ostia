import '@testing-library/jest-dom/vitest'
import type { ServerSyncStatus, SyncAttention } from '@shared/profileSync/serverSync'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { startSyncAttention, useSyncAttentionStore } from '@/stores/server/syncAttentionStore'
import { installLocalStorage } from '../../../../test/mocks/memoryStorage'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const READY: ServerSyncStatus = {
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

const NOW = Date.now()
const HOUR = 3_600_000

const ITEMS: SyncAttention[] = [
  {
    kind: 'join',
    id: 'join:d2',
    deviceId: 'd2',
    name: 'Pixel 9',
    code: 'K7QDM-2XPLA-VTRHE-4WNBC-GJ5FS',
    createdAt: NOW - 120_000,
  },
  {
    kind: 'approval',
    id: 'approval:a1',
    approvalId: 'a1',
    deviceId: 'd1',
    name: 'Studio laptop',
    createdAt: NOW - 300_000,
  },
  { kind: 'changed', id: 'changed:d3:1', deviceId: 'd3', name: 'build-box', until: NOW + HOUR },
]

describe('sync requests and device notices reach Settings, and only Settings', () => {
  let push: (items: SyncAttention[]) => void = () => {}
  let open: (page: 'server' | 'sync') => void = () => {}
  let uiInit: ReturnType<typeof useUIStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    uiInit = useUIStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  beforeEach(() => {
    installLocalStorage()
    const ostia = window.ostia
    vi.mocked(ostia.server.status).mockResolvedValue({
      url: 'https://ostia.example.com',
      host: 'ostia.example.com',
      signedIn: true,
      provider: 'invite',
      deviceName: 'Work laptop',
    })
    vi.mocked(ostia.server.info).mockResolvedValue({
      ok: true,
      offer: { relay: true, publish: false, sync: true, push: false, invite: true, github: false },
    })
    vi.mocked(ostia.server.devices).mockResolvedValue({
      ok: true,
      devices: [
        {
          id: 'me',
          name: 'Work laptop',
          current: true,
          lastSeen: NOW,
          createdAt: NOW - 40 * 24 * HOUR,
        },
        {
          id: 'd1',
          name: 'Studio laptop',
          current: false,
          lastSeen: NOW,
          createdAt: NOW - 3 * HOUR,
        },
        { id: 'd3', name: 'build-box', current: false, lastSeen: NOW, createdAt: NOW - HOUR },
      ],
    })
    vi.mocked(ostia.syncServer.status).mockResolvedValue(READY)
    vi.mocked(ostia.syncServer.attention).mockResolvedValue(ITEMS)
    vi.mocked(ostia.syncServer.onAttention).mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    vi.mocked(ostia.syncServer.onOpen).mockImplementation((cb) => {
      open = cb
      return () => {}
    })
    useSettingsStore.setState({ sync: { dir: '', method: 'server' } })
    useUIStore.setState({ settingsActive: true, settingsTabOpen: true })
    useSyncAttentionStore.setState({ items: [], hidden: new Set() })
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    useUIStore.setState(uiInit, true)
    useSettingsStore.setState(settingsInit, true)
    vi.clearAllMocks()
  })

  it('SYA-C170 shows the join request on Sync and the confirmation and changed device on Server, each page opened by main', async () => {
    await act(async () => {
      render(<SettingsPanel />)
    })
    const stop = startSyncAttention()
    await act(async () => push(ITEMS))

    await act(async () => open('sync'))
    const requests = await screen.findByRole('list', { name: 'Requests' })
    expect(within(requests).getByText('Pixel 9')).toBeInTheDocument()
    expect(within(requests).getByText('K7QDM-2XPLA-VTRHE-4WNBC-GJ5FS')).toBeInTheDocument()
    expect(
      within(requests).getByText('Check this code matches the one on Pixel 9.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Asks to confirm a change/)).toBeNull()
    expect(screen.queryByText(/Keys changed/)).toBeNull()

    await act(async () => open('server'))
    const devices = await screen.findByRole('list', { name: 'Devices' })
    expect(
      await within(devices).findByText(/Asks to confirm a change · added 3 hours ago/),
    ).toBeInTheDocument()
    expect(within(devices).getByText('Approve only if you made this change.')).toBeInTheDocument()
    expect(within(devices).getByText('Changed')).toBeInTheDocument()
    expect(within(devices).getByText(/^Keys changed · sync key ignored until /)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Requests' })).toBeNull()
    stop()
  })
})
