import '@testing-library/jest-dom/vitest'
import type { SandboxViolation } from '@shared/sandbox'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SandboxViolations } from './SandboxViolations'

const AT = new Date(2026, 9, 1, 14, 5, 9).getTime()

const NETWORK: SandboxViolation = {
  id: 'n1',
  kind: 'network',
  target: 'example.com:443',
  reason: 'not-allowed',
  detail: '',
  count: 3,
  last: AT,
  allowHost: 'example.com',
}
const BLOCKED: SandboxViolation = {
  id: 'n2',
  kind: 'network',
  target: 'ads.example.com:80',
  reason: 'blocked',
  detail: '',
  count: 1,
  last: AT,
}
const WRITE: SandboxViolation = {
  id: 'w1',
  kind: 'write',
  target: '/etc/hosts',
  reason: 'outside',
  detail: 'openat',
  count: 1,
  last: AT,
}
const OTHER: SandboxViolation = {
  id: 'o1',
  kind: 'read',
  target: '/Users/u/.ssh/id_ed25519',
  reason: 'other',
  detail: 'file-read-data',
  count: 1,
  last: AT,
}

describe('SandboxViolations', () => {
  it('says nothing was blocked, what can be seen on this system, and offers no Clear', async () => {
    render(<SandboxViolations workspaceId="ws" />)
    expect(await screen.findByText('Nothing was blocked.')).toBeInTheDocument()
    expect(screen.getByText(/Linux does not report blocked reads/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled()
    expect(window.ostia.sandbox.violations).toHaveBeenCalledWith('ws')
  })

  it('lists each violation with its kind, target, reason, count and time', async () => {
    vi.mocked(window.ostia.sandbox.violations).mockResolvedValue([NETWORK, BLOCKED, WRITE, OTHER])
    render(<SandboxViolations workspaceId="ws" />)
    const list = await screen.findByRole('list', { name: 'Blocked' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    expect(rows[0]).toHaveTextContent('Network')
    expect(rows[0]).toHaveTextContent('example.com:443')
    expect(rows[0]).toHaveTextContent('Not on the allowed list')
    expect(rows[0]).toHaveTextContent(/3× · .*5:09/)
    expect(rows[1]).toHaveTextContent('On the blocked list')
    expect(rows[2]).toHaveTextContent('Write')
    expect(rows[2]).toHaveTextContent('/etc/hosts')
    expect(rows[2]).toHaveTextContent('Outside the writable folders')
    expect(rows[3]).toHaveTextContent('Read')
    expect(rows[3]).toHaveTextContent('file-read-data')
  })

  it('offers Allow only where main says the host can be allowed, through the existing allow path', async () => {
    vi.mocked(window.ostia.sandbox.violations).mockResolvedValue([NETWORK, BLOCKED, WRITE])
    render(<SandboxViolations workspaceId="ws" />)
    const list = await screen.findByRole('list', { name: 'Blocked' })
    expect(within(list).getAllByRole('button', { name: 'Allow' })).toHaveLength(1)
    await userEvent.click(within(list).getByRole('button', { name: 'Allow' }))
    expect(window.ostia.sandbox.allowRefused).toHaveBeenCalledWith('ws', 'example.com')
  })

  it('clears the list for this workspace and shows the empty state again', async () => {
    vi.mocked(window.ostia.sandbox.violations).mockResolvedValueOnce([WRITE]).mockResolvedValue([])
    render(<SandboxViolations workspaceId="ws" />)
    await screen.findByRole('list', { name: 'Blocked' })
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(window.ostia.sandbox.clearViolations).toHaveBeenCalledWith('ws')
    await waitFor(() => expect(screen.getByText('Nothing was blocked.')).toBeInTheDocument())
  })
})
