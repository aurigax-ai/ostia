import type { GatewayRemoteStatus, GatewayTailnetState } from '@shared/types'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { GatewaySection } from './GatewaySection'

function remoteOn(tailnet: GatewayTailnetState): void {
  const status: GatewayRemoteStatus = {
    running: true,
    host: '127.0.0.1',
    port: 8722,
    fingerprint: 'sha256/x',
    deviceCount: 0,
    tailnet,
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

  it('TSN-C28 offers no bind-address choice', async () => {
    remoteOn({ state: 'off' })
    render(<GatewaySection />)
    await pairButton()
    expect(screen.queryByRole('combobox', { name: 'Bind address' })).not.toBeInTheDocument()
  })

  it('TSN-C31 keeps pairing disabled while the node has no tailnet IPv4', async () => {
    remoteOn({ state: 'running', ip: null, dnsName: 'ostia-xps15.example.ts.net' })
    render(<GatewaySection />)
    expect(await pairButton()).toBeDisabled()
    expect(await screen.findByText(/no IPv4 address/)).toBeInTheDocument()
  })
})
