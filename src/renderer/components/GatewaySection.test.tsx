import type { GatewayDevice } from '@shared/types'
import { render, screen, waitFor, within } from '@testing-library/react'
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
    vi.mocked(window.ostia.gateway.devices).mockImplementation(async () => ({
      devices: [device(caps)],
    }))
    vi.mocked(window.ostia.gateway.setCap).mockImplementation(async (_id, cap, granted) => {
      caps = granted ? [...caps, cap] : caps.filter((c) => c !== cap)
      return { ok: true, caps }
    })
  })

  it('grants and removes input for a paired device from its switch', async () => {
    const user = userEvent.setup()
    render(<GatewaySection />)

    const input = await screen.findByRole('switch', { name: 'Type into panes, Pixel' })
    expect(input).not.toBeChecked()

    await user.click(input)
    expect(window.ostia.gateway.setCap).toHaveBeenCalledWith('dev_1', 'input', true)
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Type into panes, Pixel' })).toBeChecked(),
    )

    await user.click(screen.getByRole('switch', { name: 'Type into panes, Pixel' }))
    expect(window.ostia.gateway.setCap).toHaveBeenLastCalledWith('dev_1', 'input', false)
  })

  it('grants answering agents on its own switch, apart from typing and commands', async () => {
    const user = userEvent.setup()
    render(<GatewaySection />)
    const respond = await screen.findByRole('switch', { name: 'Answer agents, Pixel' })
    expect(respond).not.toBeChecked()
    await user.click(respond)
    expect(window.ostia.gateway.setCap).toHaveBeenCalledWith('dev_1', 'respond', true)
    expect(window.ostia.gateway.setCap).toHaveBeenCalledTimes(1)
  })

  it('draws one row per permission in a single column, each with its description', async () => {
    render(<GatewaySection />)
    const grants = await screen.findByRole('group', { name: 'Permissions, Pixel' })
    const rows = grants.querySelectorAll(':scope > [data-settings-row]')
    expect(
      [...rows].map((row) => within(row as HTMLElement).getByRole('switch').ariaLabel),
    ).toEqual([
      'Answer agents, Pixel',
      'Run commands, Pixel',
      'Type into panes, Pixel',
      'Destructive commands, Pixel',
    ])
    expect(
      within(grants).getByText('Type text and keys into a terminal the phone has open.'),
    ).toBeInTheDocument()
  })

  it('keeps destructive disabled until commands are allowed and says why', async () => {
    const user = userEvent.setup()
    render(<GatewaySection />)
    const destructive = await screen.findByRole('switch', {
      name: 'Destructive commands, Pixel',
    })
    expect(destructive).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByText(
        'Commands that close panes, kill processes or discard work. Needs Run commands.',
      ),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: 'Run commands, Pixel' }))
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Destructive commands, Pixel' }),
      ).not.toHaveAttribute('aria-disabled', 'true'),
    )
  })

  it('asks before revoking, and revokes only after the confirm', async () => {
    const user = userEvent.setup()
    render(<GatewaySection />)

    await user.click(await screen.findByRole('button', { name: 'Revoke Pixel' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke Pixel?' })
    expect(window.ostia.gateway.revoke).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(window.ostia.gateway.revoke).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Revoke Pixel' }))
    const again = await screen.findByRole('alertdialog', { name: 'Revoke Pixel?' })
    await user.click(within(again).getByRole('button', { name: 'Revoke' }))
    expect(window.ostia.gateway.revoke).toHaveBeenCalledWith('dev_1')
  })

  it('asks for confirmation before granting destructive, and cancel grants nothing', async () => {
    caps = ['read', 'notify', 'command']
    const user = userEvent.setup()
    render(<GatewaySection />)

    await user.click(await screen.findByRole('switch', { name: 'Destructive commands, Pixel' }))
    expect(await screen.findByText('Allow destructive commands?')).toBeInTheDocument()
    expect(window.ostia.gateway.setCap).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(screen.queryByText('Allow destructive commands?')).not.toBeInTheDocument(),
    )
    expect(window.ostia.gateway.setCap).not.toHaveBeenCalled()
  })

  it('grants destructive only after the confirm button', async () => {
    caps = ['read', 'notify', 'command']
    const user = userEvent.setup()
    render(<GatewaySection />)

    await user.click(await screen.findByRole('switch', { name: 'Destructive commands, Pixel' }))
    await user.click(await screen.findByRole('button', { name: 'Allow destructive' }))

    expect(window.ostia.gateway.setCap).toHaveBeenCalledWith('dev_1', 'destructive', true)
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Destructive commands, Pixel' })).toBeChecked(),
    )
  })
})
