import type { GatewayRemoteStatus, GatewayRoute, GatewayTailnetState } from '@shared/types'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { GatewaySection } from './GatewaySection'

function remoteOn(
  tailnet: GatewayTailnetState,
  route: GatewayRoute = { kind: 'tailnet' },
  running = true,
): void {
  const status: GatewayRemoteStatus = {
    running,
    host: route.kind === 'address' ? route.address : '127.0.0.1',
    port: 8722,
    fingerprint: 'sha256/x',
    deviceCount: 0,
    tailnet,
    route,
    discoverable: false,
  }
  vi.mocked(window.ostia.gateway.status).mockResolvedValue(status)
}

const pairButton = (): Promise<HTMLElement> =>
  screen.findByRole('button', { name: 'Show pairing code' })

describe('Settings → Remote over the tailnet', () => {
  it('TSN-C11 asks to sign in to Tailscale and offers no pairing before sign-in', async () => {
    remoteOn({ state: 'needs-login', authUrl: 'https://login.tailscale.com/a/abc' })
    render(<GatewaySection />)
    const signIn = await screen.findByRole('button', { name: 'Sign in to Tailscale' })
    expect(await pairButton()).toBeDisabled()
    await userEvent.setup().click(signIn)
    expect(window.ostia.gateway.tailnetSignIn).toHaveBeenCalledTimes(1)
  })

  it('TSN-C12 shows the node name and tailnet address and enables pairing', async () => {
    remoteOn({ state: 'running', ip: '100.114.10.128', dnsName: 'ostia-xps15.example.ts.net' })
    render(<GatewaySection />)
    expect(await screen.findByText(/ostia-xps15\.example\.ts\.net/)).toBeInTheDocument()
    expect(screen.getByText(/100\.114\.10\.128/)).toBeInTheDocument()
    expect(await pairButton()).toBeEnabled()
  })

  it('TSN-C13 says the helper stopped and disables pairing', async () => {
    remoteOn({ state: 'error', code: 'helper-stopped' })
    render(<GatewaySection />)
    expect(await screen.findByText(/The Tailscale helper stopped/)).toBeInTheDocument()
    expect(await pairButton()).toBeDisabled()
  })

  it('TSN-C18 says why an unsafe state folder was refused', async () => {
    remoteOn({ state: 'error', code: 'state-dir-unsafe' })
    render(<GatewaySection />)
    expect(await screen.findByText(/Tailscale folder is not safe to use/)).toBeInTheDocument()
  })

  it('TSN-C25 shows an error when a login link is refused', async () => {
    remoteOn({ state: 'needs-login', authUrl: 'https://evil.example/a/abc' })
    vi.mocked(window.ostia.gateway.tailnetSignIn).mockResolvedValue({
      ok: false,
      error: 'login-link-refused',
    })
    render(<GatewaySection />)
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Sign in to Tailscale' }))
    expect(await screen.findByText(/refused a login link/)).toBeInTheDocument()
  })

  it('TSN-C37 offers Tailscale and each local address, and saves the pick while off', async () => {
    remoteOn({ state: 'off' }, { kind: 'tailnet' }, false)
    vi.mocked(window.ostia.gateway.bindAddresses).mockResolvedValue([
      { address: '192.168.2.108', iface: 'wlan0' },
    ])
    const user = userEvent.setup()
    render(<GatewaySection />)
    const choice = await screen.findByRole('combobox', { name: 'Connect through' })
    expect(choice).toHaveTextContent(/Tailscale/)
    await user.click(choice)
    await user.click(await screen.findByRole('option', { name: 'wlan0 · 192.168.2.108' }))
    expect(window.ostia.gateway.setRoute).toHaveBeenCalledWith({
      kind: 'address',
      address: '192.168.2.108',
    })
  })

  it('TSN-C38 locks the route while remote access is on', async () => {
    remoteOn({ state: 'off' })
    render(<GatewaySection />)
    expect(await screen.findByRole('combobox', { name: 'Connect through' })).toBeDisabled()
  })

  it('TSN-C39 on a picked address hides Tailscale, warns and allows pairing', async () => {
    remoteOn({ state: 'off' }, { kind: 'address', address: '192.168.2.108' })
    render(<GatewaySection />)
    expect(await screen.findByText(/Listens on 192\.168\.2\.108/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in to Tailscale' })).not.toBeInTheDocument()
    expect(screen.queryByText('Not signed in')).not.toBeInTheDocument()
    expect(await pairButton()).toBeEnabled()
  })

  it('TSN-C41 says when the saved address is gone instead of turning on', async () => {
    remoteOn({ state: 'off' }, { kind: 'address', address: '10.1.2.3' }, false)
    vi.mocked(window.ostia.gateway.enable).mockResolvedValueOnce({ error: 'address-unavailable' })
    render(<GatewaySection />)
    await userEvent
      .setup()
      .click(await screen.findByRole('switch', { name: 'Enable remote access' }))
    expect(await screen.findByText(/10\.1\.2\.3 is no longer on this computer/)).toBeInTheDocument()
  })

  it('TSN-C42 shows the pair code beside the QR and keeps the JSON folded', async () => {
    remoteOn({ state: 'running', ip: '100.64.0.1', dnsName: 'ostia-x.example.ts.net' })
    const user = userEvent.setup()
    render(<GatewaySection />)
    await user.click(await pairButton())
    expect(await screen.findByText('ABCD-1234')).toBeInTheDocument()
    expect(screen.getByText('100.64.0.1:8722')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Connection details' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Connection details' }))
    const details = screen.getByRole('textbox', { name: 'Connection details' })
    expect((details as HTMLTextAreaElement).value).toContain('"pairCode": "ABCD1234"')
  })

  it('TSN-C31 keeps pairing disabled while the node has no tailnet IPv4', async () => {
    remoteOn({ state: 'running', ip: null, dnsName: 'ostia-xps15.example.ts.net' })
    render(<GatewaySection />)
    expect(await pairButton()).toBeDisabled()
    expect(await screen.findByText(/no IPv4 address/)).toBeInTheDocument()
  })
})
