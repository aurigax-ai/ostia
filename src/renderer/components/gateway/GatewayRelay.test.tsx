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

const RELAY_ROUTE: GatewayRoute = { ...LOOPBACK_ROUTE, relay: true }

function remote(
  route: GatewayRoute,
  relay: GatewayRelayState,
  running = false,
  signedIn = true,
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
    push: 'available',
  }
  vi.mocked(window.ostia.gateway.status).mockResolvedValue(status)
  vi.mocked(window.ostia.server.status).mockResolvedValue({
    url: signedIn ? 'https://ostia.example.com' : null,
    host: signedIn ? 'ostia.example.com' : null,
    signedIn,
    provider: 'invite',
    deviceName: 'Desk',
  })
}

const pairButton = (): Promise<HTMLElement> => screen.findByRole('button', { name: 'Show QR' })

afterEach(() => {
  cleanup()
})

describe('Settings › Remote through Ostia Relay', () => {
  it('RLY-C47 names the server and says it only forwards bytes', async () => {
    remote(RELAY_ROUTE, { state: 'listening', host: 'lblabc.relay.test', port: 443 }, true)
    render(<GatewaySection />)
    expect(await screen.findByText(/ostia\.example\.com only forwards bytes/)).toHaveTextContent(
      /ends TLS with its pinned certificate/,
    )
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByText('Running · Ostia Relay')).toBeInTheDocument()
  })

  it('RLY-C48 signed out shows one line with a Sign in link to Sync and blocks the switch', async () => {
    remote(RELAY_ROUTE, { state: 'needs-sign-in' }, false, false)
    render(<GatewaySection />)
    expect(await screen.findByText('The relay needs an Ostia account.')).toBeInTheDocument()
    expect(screen.queryByText('Relay server')).toBeNull()
    expect(screen.getByRole('switch', { name: 'Enable remote access' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    const openSettings = vi.spyOn(useUIStore.getState(), 'openSettings')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }))
    expect(openSettings).toHaveBeenCalledWith('sync', { signIn: true })
  })

  it('RLY-C49 choosing Ostia Relay turns every other method off', async () => {
    remote(
      { ...LOOPBACK_ROUTE, bindAddress: '192.168.2.108', bindInterface: 'wlan0' },
      { state: 'off' },
    )
    const user = userEvent.setup()
    render(<GatewaySection />)
    await user.click(await screen.findByRole('combobox', { name: 'Connection method' }))
    await user.click(await screen.findByRole('option', { name: 'Ostia Relay' }))
    expect(window.ostia.gateway.setRoute).toHaveBeenCalledWith(RELAY_ROUTE)
  })

  it('RLY-C50 locks the method while the gateway runs', async () => {
    remote(RELAY_ROUTE, { state: 'connecting' }, true)
    render(<GatewaySection />)
    const method = await screen.findByRole('combobox', { name: 'Connection method' })
    await waitFor(() => expect(method).toBeDisabled())
    expect(method).toHaveTextContent('Ostia Relay')
  })

  it('RLY-C53 says when the relay cannot connect and that it retries', async () => {
    remote(RELAY_ROUTE, { state: 'error', code: 'unreachable' }, true)
    render(<GatewaySection />)
    expect(await screen.findByText(/relay is not connected \(unreachable\)/)).toBeInTheDocument()
  })

  it('RLY-C54 enables pairing on 127.0.0.1 only once the relay is listening', async () => {
    remote(RELAY_ROUTE, { state: 'connecting' }, true)
    const first = render(<GatewaySection />)
    expect(await pairButton()).toBeDisabled()
    first.unmount()
    remote(RELAY_ROUTE, { state: 'listening', host: 'lblabc.relay.test', port: 443 }, true)
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
    remote(RELAY_ROUTE, { state: 'connecting' }, true)
    render(<GatewaySection />)
    expect(await pairButton()).toBeDisabled()
    act(() => push({ state: 'listening', host: 'lblabc.relay.test', port: 443 }))
    expect(await pairButton()).toBeEnabled()
  })

  it('RLY-C56 warns that 127.0.0.1 is unreachable on Network address with no public address', async () => {
    remote(LOOPBACK_ROUTE, { state: 'off' })
    render(<GatewaySection />)
    expect(await screen.findByText(/A phone cannot reach 127\.0\.0\.1/)).toBeInTheDocument()
  })
})
