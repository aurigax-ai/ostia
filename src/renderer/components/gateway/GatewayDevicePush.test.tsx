import type {
  GatewayDevice,
  GatewayPushAvailability,
  GatewayRemoteStatus,
} from '@shared/gateway/gatewayApi'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../../test/render'
import { GatewaySection } from './GatewaySection'

function device(push: GatewayDevice['push'], caps = ['read', 'notify']): GatewayDevice {
  return {
    deviceId: 'dev_1',
    name: 'Pixel',
    pubkey: 'pk',
    caps,
    createdAt: '2026-09-01T00:00:00.000Z',
    push,
  }
}

async function show(
  push: GatewayDevice['push'],
  availability: GatewayPushAvailability = 'available',
  caps?: string[],
): Promise<void> {
  const status = await window.ostia.gateway.status()
  vi.mocked(window.ostia.gateway.status).mockResolvedValue({
    ...status,
    push: availability,
  } satisfies GatewayRemoteStatus)
  vi.mocked(window.ostia.gateway.devices).mockResolvedValue({ devices: [device(push, caps)] })
  await renderSettled(<GatewaySection />)
}

const pushSwitch = (): Promise<HTMLElement> =>
  screen.findByRole('switch', { name: 'Notify through the server, Pixel' })

afterEach(() => {
  cleanup()
})

describe('Settings › Remote › Notify through the server', () => {
  it('PSH-C53 shows the switch off with what a wake-up carries', async () => {
    await show({ enabled: false, registered: false })
    expect(await pushSwitch()).not.toBeChecked()
    expect(screen.getByText(/A wake-up carries no text/)).toBeInTheDocument()
  })

  it('PSH-C54 says the phone has to register while the switch is on and nothing is registered', async () => {
    await show({ enabled: true, registered: false })
    expect(await pushSwitch()).toBeChecked()
    expect(screen.getByText(/Waiting for the phone to register/)).toBeInTheDocument()
  })

  it('PSH-C55 says it is on once the phone registered', async () => {
    await show({ enabled: true, registered: true })
    expect(await pushSwitch()).toBeChecked()
    expect(screen.getByText(/^On\. Your server wakes this phone/)).toBeInTheDocument()
  })

  it('PSH-C56 disables the switch and gives the reason when push is unavailable', async () => {
    const reasons: Array<[GatewayPushAvailability, RegExp]> = [
      ['not-signed-in', /signed in to your server/],
      ['server-push-off', /does not offer push/],
      ['unreachable', /cannot be reached/],
    ]
    for (const [availability, text] of reasons) {
      await show({ enabled: false, registered: false }, availability)
      expect(await pushSwitch()).toHaveAttribute('aria-disabled', 'true')
      expect(screen.getByText(text)).toBeInTheDocument()
      cleanup()
    }
  })

  it('PSH-C57 disables the switch for a phone that may not be notified', async () => {
    await show({ enabled: false, registered: false }, 'available', ['read'])
    expect(await pushSwitch()).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('This phone is not allowed notifications.')).toBeInTheDocument()
  })

  it('PSH-C58 turns the switch on and off through the owner IPC', async () => {
    await show({ enabled: false, registered: false })
    const user = userEvent.setup()
    await user.click(await pushSwitch())
    expect(window.ostia.gateway.setDevicePush).toHaveBeenCalledWith('dev_1', true)
    cleanup()
    await show({ enabled: true, registered: true })
    await user.click(await pushSwitch())
    expect(window.ostia.gateway.setDevicePush).toHaveBeenLastCalledWith('dev_1', false)
  })

  it('PSH-C59 shows why the main process refused the switch', async () => {
    vi.mocked(window.ostia.gateway.setDevicePush).mockResolvedValueOnce({
      ok: false,
      error: 'server-push-off',
    })
    await show({ enabled: false, registered: false })
    await userEvent.setup().click(await pushSwitch())
    await waitFor(() =>
      expect(screen.getAllByText('Your server does not offer push.').length).toBeGreaterThan(0),
    )
  })

  it('PSH-C60 refreshes the list when the main process says push changed', async () => {
    await show({ enabled: true, registered: false })
    await pushSwitch()
    const onChanged = vi.mocked(window.ostia.gateway.onPushChanged).mock.calls.at(-1)?.[0]
    vi.mocked(window.ostia.gateway.devices).mockResolvedValue({
      devices: [device({ enabled: true, registered: true })],
    })
    onChanged?.()
    expect(await screen.findByText(/^On\. Your server wakes this phone/)).toBeInTheDocument()
  })
})
