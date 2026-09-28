import type { GatewayDevice } from '@shared/types'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewaySection } from './GatewaySection'

function device(caps: string[]): GatewayDevice {
  return {
    deviceId: 'dev_1',
    name: 'Pixel',
    pubkey: 'pk',
    caps,
    createdAt: '2026-09-01T00:00:00.000Z',
  }
}

describe('GatewaySection', () => {
  let caps: string[]

  beforeEach(() => {
    caps = ['read', 'notify']
    vi.mocked(window.pine.gateway.devices).mockImplementation(async () => ({
      devices: [device(caps)],
    }))
    vi.mocked(window.pine.gateway.setCap).mockImplementation(async (_id, cap, granted) => {
      caps = granted ? [...caps, cap] : caps.filter((c) => c !== cap)
      return { ok: true, caps }
    })
  })

  it('grants and removes input for a paired device from its switch', async () => {
    const user = userEvent.setup()
    render(<GatewaySection />)

    const input = await screen.findByRole('switch', { name: 'Type into panes — Pixel' })
    expect(input).not.toBeChecked()

    await user.click(input)
    expect(window.pine.gateway.setCap).toHaveBeenCalledWith('dev_1', 'input', true)
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Type into panes — Pixel' })).toBeChecked(),
    )

    await user.click(screen.getByRole('switch', { name: 'Type into panes — Pixel' }))
    expect(window.pine.gateway.setCap).toHaveBeenLastCalledWith('dev_1', 'input', false)
  })

  it('keeps destructive disabled until commands are allowed', async () => {
    render(<GatewaySection />)
    const destructive = await screen.findByRole('switch', {
      name: 'Destructive commands — Pixel',
    })
    expect(destructive).toHaveAttribute('aria-disabled', 'true')
  })

  it('asks for confirmation before granting destructive, and cancel grants nothing', async () => {
    caps = ['read', 'notify', 'command']
    const user = userEvent.setup()
    render(<GatewaySection />)

    await user.click(await screen.findByRole('switch', { name: 'Destructive commands — Pixel' }))
    expect(await screen.findByText('Allow destructive commands?')).toBeInTheDocument()
    expect(window.pine.gateway.setCap).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(screen.queryByText('Allow destructive commands?')).not.toBeInTheDocument(),
    )
    expect(window.pine.gateway.setCap).not.toHaveBeenCalled()
  })

  it('grants destructive only after the confirm button', async () => {
    caps = ['read', 'notify', 'command']
    const user = userEvent.setup()
    render(<GatewaySection />)

    await user.click(await screen.findByRole('switch', { name: 'Destructive commands — Pixel' }))
    await user.click(await screen.findByRole('button', { name: 'Allow destructive' }))

    expect(window.pine.gateway.setCap).toHaveBeenCalledWith('dev_1', 'destructive', true)
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Destructive commands — Pixel' })).toBeChecked(),
    )
  })

  it('warns when a non-loopback bind address is selected and enables on it', async () => {
    vi.mocked(window.pine.gateway.bindOptions).mockResolvedValue({
      addresses: [
        { address: '127.0.0.1', kind: 'loopback' },
        { address: '100.101.1.2', kind: 'tailscale', iface: 'tailscale0' },
      ],
      selected: '100.101.1.2',
    })
    const user = userEvent.setup()
    render(<GatewaySection />)

    expect(await screen.findByText(/Anyone who can reach 100\.101\.1\.2/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Bind address' })).toHaveTextContent(
      'Tailscale (tailscale0) · 100.101.1.2',
    )

    await user.click(screen.getByRole('switch', { name: 'Enable remote access' }))
    expect(window.pine.gateway.enable).toHaveBeenCalledWith({ host: '100.101.1.2' })
  })
})
