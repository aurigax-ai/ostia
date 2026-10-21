import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/stores/app/uiStore'
import { AccountsMenu } from './AccountsMenu'

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
      { id: 'default', email: 'me@example.com' },
      { id: WORK, email: 'work@example.com' },
    ],
    current: WORK,
    adding: false,
    duplicate: null,
  })
  render(<AccountsMenu />)
  return userEvent.click(screen.getByRole('button', { name: 'Claude accounts' }))
}

describe('AccountsMenu', () => {
  it('lists the accounts with a check on the one new sessions use', async () => {
    await open()
    const work = await screen.findByRole('menuitem', { name: /work@example.com/ })
    expect(work.querySelector('[aria-label="Active"]')).not.toBeNull()
    expect(
      screen
        .getByRole('menuitem', { name: /me@example.com/ })
        .querySelector('[aria-label="Active"]'),
    ).toBeNull()
  })

  it('switches the account on a click', async () => {
    await open()
    await userEvent.click(await screen.findByRole('menuitem', { name: /me@example.com/ }))
    expect(window.ostia.claudeAccounts.use).toHaveBeenCalledWith('default')
  })

  it('offers Manual rotation only', async () => {
    await open()
    expect(await screen.findByRole('button', { name: 'Manual' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.queryByRole('button', { name: 'Custom' })).toBeNull()
  })

  it('opens the Claude accounts settings page', async () => {
    const openSettings = vi.fn()
    useUIStore.setState({ openSettings })
    await open()
    await userEvent.click(await screen.findByText('Manage accounts…'))
    expect(openSettings).toHaveBeenCalledWith('claudeAccounts')
  })
})
