import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayPhoneWorkspace } from './GatewayPhoneWorkspace'

describe('GatewayPhoneWorkspace', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('PHW-C7 shows the default folder, chooses another through the owner IPC and goes back', async () => {
    const gateway = window.ostia.gateway
    vi.mocked(window.ostia.sync.pickFolder).mockResolvedValueOnce('/home/me')
    vi.mocked(gateway.setPhoneWorkspace).mockResolvedValueOnce({ ok: false, error: 'home' })
    render(<GatewayPhoneWorkspace />)
    expect(await screen.findByText('/data/ostia/remote-workspace')).toBeTruthy()
    expect(screen.getByText('Made when a phone first starts a session.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Use default' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }))
    await waitFor(() =>
      expect(gateway.setPhoneWorkspace).toHaveBeenCalledWith({
        folder: '/home/me',
        agent: 'claude',
      }),
    )
    expect(await screen.findByText("Your home folder can't be the Phone workspace.")).toBeTruthy()

    vi.mocked(window.ostia.sync.pickFolder).mockResolvedValueOnce('/home/me/jobs')
    vi.mocked(gateway.setPhoneWorkspace).mockResolvedValueOnce({
      ok: true,
      value: {
        folder: '/home/me/jobs',
        isDefault: false,
        absent: false,
        agent: 'claude',
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }))
    expect(await screen.findByText('/home/me/jobs')).toBeTruthy()
    expect(screen.queryByText(/folder trust/i)).toBeNull()

    vi.mocked(gateway.setPhoneWorkspace).mockResolvedValueOnce({
      ok: true,
      value: {
        folder: '/data/ostia/remote-workspace',
        isDefault: true,
        absent: false,
        agent: 'claude',
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }))
    await waitFor(() =>
      expect(gateway.setPhoneWorkspace).toHaveBeenLastCalledWith({
        folder: null,
        agent: 'claude',
      }),
    )
    expect(await screen.findByText('/data/ostia/remote-workspace')).toBeTruthy()
  })
})
