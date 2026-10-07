import type { GatewayPairRequest, GatewayRemoteStatus } from '@shared/types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewaySection } from './GatewaySection'

const STATUS: GatewayRemoteStatus = {
  running: true,
  host: '127.0.0.1',
  port: 8722,
  fingerprint: 'sha256/x',
  deviceCount: 0,
  tailnet: { state: 'running', ip: '100.64.0.1', dnsName: 'ostia-x.example.ts.net' },
  route: { kind: 'tailnet' },
  discoverable: false,
}

const STATUS_LATENCY_MS = 50

function qr(pairCode: string) {
  return {
    v: 1 as const,
    host: '100.64.0.1',
    port: 8722,
    fingerprint: 'sha256/x',
    pairCode,
    name: 'x',
  }
}

async function showCode(): Promise<void> {
  const button = await screen.findByRole('button', { name: 'Show pairing code' })
  await waitFor(() => expect(button).toBeEnabled())
  await act(async () => {
    fireEvent.click(button)
  })
}

async function tick(seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
  }
}

describe('GatewaySection pairing', () => {
  beforeEach(() => {
    vi.mocked(window.ostia.gateway.status).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(STATUS), STATUS_LATENCY_MS)),
    )
    vi.mocked(window.ostia.gateway.pair)
      .mockResolvedValueOnce(qr('ABCD2345'))
      .mockResolvedValueOnce(qr('WXYZ6789'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('CPD-C7 shows the pairing code as ABCD-EFGH', async () => {
    render(<GatewaySection />)
    await showCode()
    expect(await screen.findByText('ABCD-2345')).toBeInTheDocument()
  })

  it('CPD-C9 replaces the code with a new one when it expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<GatewaySection />)
    await showCode()
    expect(await screen.findByText('ABCD-2345')).toBeInTheDocument()
    await tick(121)
    expect(window.ostia.gateway.pair).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('WXYZ-6789')).toBeInTheDocument()
  })

  it('CPD-C10 issues no new code once Settings → Remote is closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const view = render(<GatewaySection />)
    await showCode()
    await screen.findByText('ABCD-2345')
    view.unmount()
    await tick(130)
    expect(window.ostia.gateway.pair).toHaveBeenCalledTimes(1)
  })

  it('CPD-C13 shows a waiting phone with its check code and approves it', async () => {
    const request: GatewayPairRequest = { requestId: 'r1', name: 'Pixel 9', checkCode: '396848' }
    vi.mocked(window.ostia.gateway.pairRequests).mockResolvedValue([request])
    const user = userEvent.setup()
    render(<GatewaySection />)

    expect(await screen.findByText('Pixel 9 wants to pair')).toBeInTheDocument()
    expect(screen.getByText('396 848')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Approve Pixel 9' }))
    expect(window.ostia.gateway.answerPairRequest).toHaveBeenCalledWith('r1', true)
  })

  it('turns Discoverable on from its switch', async () => {
    const user = userEvent.setup()
    render(<GatewaySection />)
    await user.click(await screen.findByRole('switch', { name: 'Discoverable' }))
    expect(window.ostia.gateway.setDiscoverable).toHaveBeenCalledWith(true)
  })
})
