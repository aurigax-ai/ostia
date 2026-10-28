import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/assist/chatTools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/assist/chatTools')>()),
  workspaceFolder: () => '/home/u/proj',
}))

import { ensureAgentSession, useAgentStore } from '@/stores/agent/agentStore'
import { ManagerAgentPane } from './ManagerAgentPane'

describe('the pi manager pane', () => {
  afterEach(() => {
    cleanup()
    useAgentStore.setState({ current: {} })
  })

  it('PIM-C13 shows nothing until the manager session exists', () => {
    render(<ManagerAgentPane workspaceId="wm1" paneId="pm1" />)
    expect(screen.getByText('Manager session')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('PIM-C14 shows the strip, the folder line, the key hints and the composer', async () => {
    await ensureAgentSession('wm2', 'pm2', undefined, 'manager')
    render(<ManagerAgentPane workspaceId="wm2" paneId="pm2" />)
    expect(screen.getByText('Manager session')).toBeInTheDocument()
    expect(
      await screen.findByText('Send a prompt below to start the manager session in /home/u/proj'),
    ).toBeInTheDocument()
    expect(screen.getByText('add context')).toBeInTheDocument()
    expect(screen.getByText('send')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Your question' })).toBeInTheDocument()
  })
})
