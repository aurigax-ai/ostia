import type {
  GatewayRelayState,
  GatewayRemoteStatus,
  GatewayRoute,
} from '@shared/gateway/gatewayApi'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/stores/app/uiStore'
import { GatewaySection } from './GatewaySection'

const LOOPBACK_ROUTE: GatewayRoute = {
  bindAddress: '127.0.0.1',
  bindInterface: null,
  tailnet: false,
  phoneAddress: null,
  relay: false,
}

function remote(
  route: GatewayRoute,
  relay: GatewayRelayState,
  running = false,
  host: string | null = 'ostia.example.com',
): void {
  const status: GatewayRemoteStatus = {
    running,
    host: route.bindAddress,
    port: 8722,
    fingerprint: 'sha256/x',
    deviceCount: 0,
    tailnet: { state: 'off' },
    route,
    relay,
    discoverable: false,
  }
  vi.mocked(window.ostia.gateway.status).mockResolvedValue(status)
  vi.mocked(window.ostia.server.status).mockResolvedValue({
    url: host ? `https://${host}` : null,
    host,
    signedIn: true,
    provider: 'invite',
    deviceName: 'Desk',
  })
}

const pairButton = (): Promise<HTMLElement> =>
  screen.findByRole('button', { name: 'Show pairing code' })

afterEach(() => {
  cleanup()
})

describe('Settings › Remote through a relay server', () => {
  it('RLY-C47 names the configured server and says it only forwards bytes', async () => {
    remote(LOOPBACK_ROUTE, { state: 'off' })
    render(<GatewaySection />)
    const toggle = await screen.findByRole('switch', { name: 'Through a relay server' })
    expect(toggle).not.toBeChecked()
    expect(
      await screen.findByText(/through ostia\.example\.com, which only forwards bytes/),
    ).toHaveTextContent(/still ends TLS with its pinned certificate/)
  })

  it('RLY-C48 points at Server settings when no server is set, and never mentions Tailscale', async () => {
    remote(LOOPBACK_ROUTE, { state: 'off' }, false, null)
    render(<GatewaySection />)
    const desc = await screen.findByText(/relay server you set up in Server settings/)
    expect(desc).not.toHaveTextContent(/Tailscale/i)
  })

  it('RLY-C49 saves the relay choice in the route while the gateway is off', async () => {
    remote(LOOPBACK_ROUTE, { state: 'off' })
    render(<GatewaySection />)
    await userEvent
      .setup()
      .click(await screen.findByRole('switch', { name: 'Through a relay server' }))
    expect(window.ostia.gateway.setRoute).toHaveBeenCalledWith({ ...LOOPBACK_ROUTE, relay: true })
  })

  it('RLY-C50 locks the relay switch while the gateway runs', async () => {
    remote({ ...LOOPBACK_ROUTE, relay: true }, { state: 'connecting' }, true)
    render(<GatewaySection />)
    await screen.findByRole('switch', { name: 'Through a relay server' })
    const toggle = (): HTMLElement => screen.getByRole('switch', { name: 'Through a relay server' })
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-disabled', 'true'))
    expect(toggle()).toBeChecked()
  })

  it('RLY-C51 asks to sign in to the server and links to Settings › Server', async () => {
    remote({ ...LOOPBACK_ROUTE, relay: true }, { state: 'needs-sign-in' })
    render(<GatewaySection />)
    expect(await screen.findByText(/needs this computer to be signed in/)).toBeInTheDocument()
    const openSettings = vi.spyOn(useUIStore.getState(), 'openSettings')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open Server settings' }))
    expect(openSettings).toHaveBeenCalledWith('server')
  })

  it('RLY-C52 shows no sign-in notice when the relay is off', async () => {
    remote(LOOPBACK_ROUTE, { state: 'needs-sign-in' })
    render(<GatewaySection />)
    await screen.findByRole('switch', { name: 'Through a relay server' })
    expect(screen.queryByText(/needs this computer to be signed in/)).toBeNull()
  })

  it('RLY-C53 says when the relay cannot connect and that it retries', async () => {
    remote({ ...LOOPBACK_ROUTE, relay: true }, { state: 'error', code: 'unreachable' }, true)
    render(<GatewaySection />)
    expect(await screen.findByText(/relay is not connected \(unreachable\)/)).toBeInTheDocument()
  })

  it('RLY-C54 enables pairing on 127.0.0.1 only once the relay is listening', async () => {
    remote({ ...LOOPBACK_ROUTE, relay: true }, { state: 'connecting' }, true)
    const first = render(<GatewaySection />)
    expect(await pairButton()).toBeDisabled()
    first.unmount()
    remote(
      { ...LOOPBACK_ROUTE, relay: true },
      { state: 'listening', host: 'lblabc.relay.test' },
      true,
    )
    render(<GatewaySection />)
    expect(await pairButton()).toBeEnabled()
    expect(screen.queryByText(/A phone cannot reach 127\.0\.0\.1/)).toBeNull()
  })

  it('RLY-C55 follows relay changes pushed by main', async () => {
    let push: (state: GatewayRelayState) => void = () => {}
    vi.mocked(window.ostia.gateway.onRelayChanged).mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    remote({ ...LOOPBACK_ROUTE, relay: true }, { state: 'connecting' }, true)
    render(<GatewaySection />)
    expect(await pairButton()).toBeDisabled()
    act(() => push({ state: 'listening', host: 'lblabc.relay.test' }))
    expect(await pairButton()).toBeEnabled()
  })

  it('RLY-C56 still warns that 127.0.0.1 is unreachable when no route reaches a phone', async () => {
    remote(LOOPBACK_ROUTE, { state: 'off' })
    render(<GatewaySection />)
    expect(await screen.findByText(/A phone cannot reach 127\.0\.0\.1/)).toBeInTheDocument()
  })
})
