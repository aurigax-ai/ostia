import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SandboxPortsTab } from './SandboxPortsTab'

async function exposeFails(error: string): Promise<void> {
  vi.mocked(window.pine.sandbox.ports).mockResolvedValue([
    { port: 5173, process: 'node', exposed: false },
  ])
  vi.mocked(window.pine.sandbox.expose).mockResolvedValue({ ok: false, error })
  render(<SandboxPortsTab workspaceId="ws" />)
  await userEvent.click(await screen.findByRole('button', { name: 'Expose' }))
}

describe('SandboxPortsTab', () => {
  it('says to allow Unix sockets when a port cannot be exposed because they are off', async () => {
    await exposeFails('unix-sockets-off')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Port 5173 cannot be exposed while Unix sockets are off for this sandbox. Allow Unix sockets, then restart its terminals.',
    )
    expect(window.pine.sandbox.expose).toHaveBeenCalledWith('ws', 5173)
  })

  it('names the reason when the port is taken on this computer', async () => {
    await exposeFails('port-in-use')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not expose port 5173: port-in-use',
    )
  })
})
