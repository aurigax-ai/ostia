import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayPhoneWorkspace } from './GatewayPhoneWorkspace'

describe('GatewayPhoneWorkspace', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('PHW-C7 chooses a folder through the owner IPC and shows a refusal under the row', async () => {
    const gateway = window.ostia.gateway
    vi.mocked(window.ostia.sync.pickFolder).mockResolvedValueOnce('/home/me')
    vi.mocked(gateway.setPhoneWorkspace).mockResolvedValueOnce({ ok: false, error: 'home' })
    render(<GatewayPhoneWorkspace />)
    expect(await screen.findByText('None')).toBeTruthy()
    expect(
      screen
        .getByRole('switch', { name: 'Open new phone sessions there' })
        .hasAttribute('data-disabled'),
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }))
    await waitFor(() =>
      expect(gateway.setPhoneWorkspace).toHaveBeenCalledWith({
        folder: '/home/me',
        openNew: false,
        agent: 'claude',
      }),
    )
    expect(await screen.findByText("Your home folder can't be the Phone workspace.")).toBeTruthy()

    vi.mocked(window.ostia.sync.pickFolder).mockResolvedValueOnce('/home/me/jobs')
    vi.mocked(gateway.setPhoneWorkspace).mockResolvedValueOnce({
      ok: true,
      value: { folder: '/home/me/jobs', openNew: false, agent: 'claude', trust: 'ask' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }))
    expect(await screen.findByText('/home/me/jobs')).toBeTruthy()
    expect(screen.getByText('Not trusted yet')).toBeTruthy()
    expect(
      screen
        .getByRole('switch', { name: 'Open new phone sessions there' })
        .hasAttribute('data-disabled'),
    ).toBe(false)
  })
})
