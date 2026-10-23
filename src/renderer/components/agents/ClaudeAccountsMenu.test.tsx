import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/stores/app/uiStore'
import { ClaudeAccountsMenu } from './ClaudeAccountsMenu'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const WORK = 'a'.repeat(16)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function open() {
  vi.mocked(window.ostia.claudeAccounts.state).mockResolvedValue({
    accounts: [
      { id: 'default', email: 'me@example.com', signedOut: false },
      { id: WORK, email: 'work@example.com', signedOut: false },
    ],
    current: WORK,
    adding: false,
    signInAvailable: false,
    signIn: 'idle',
    duplicate: null,
    damaged: false,
    recoverable: 0,
  })
  render(<ClaudeAccountsMenu />)
  return userEvent.click(screen.getByRole('button', { name: 'Claude accounts' }))
}

describe('ClaudeAccountsMenu', () => {
  it('lists the accounts as one choice with the current one checked', async () => {
    await open()
    const work = await screen.findByRole('menuitemradio', { name: /work@example.com/ })
    expect(work).toHaveAttribute('aria-checked', 'true')
    const first = screen.getByRole('menuitemradio', { name: /me@example.com/ })
    expect(first).toHaveAttribute('aria-checked', 'false')
    expect(first).toHaveTextContent('Default')
  })

  it('switches the account on a click', async () => {
    await open()
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /me@example.com/ }))
    expect(window.ostia.claudeAccounts.use).toHaveBeenCalledWith('default')
  })

  it('shows no rotation control until it does something', async () => {
    await open()
    await screen.findByRole('menuitemradio', { name: /work@example.com/ })
    expect(screen.queryByText('Rotation')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Manual' })).toBeNull()
  })

  it('opens the Claude accounts settings page', async () => {
    const openSettings = vi.fn()
    useUIStore.setState({ openSettings })
    await open()
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Manage accounts…' }))
    expect(openSettings).toHaveBeenCalledWith('claudeAccounts')
  })
})
