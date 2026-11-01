import '@testing-library/jest-dom/vitest'
import type { ClaudeAccountsState } from '@shared/claudeAccounts/claudeAccounts'
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

function open(over: Partial<ClaudeAccountsState> = {}) {
  vi.mocked(window.ostia.claudeAccounts.state).mockResolvedValue({
    accounts: [
      {
        id: 'default',
        email: 'me@example.com',
        signedOut: false,
        enabled: true,
        sameAs: null,
        usage: null,
      },
      {
        id: WORK,
        email: 'work@example.com',
        signedOut: false,
        enabled: true,
        sameAs: null,
        usage: null,
      },
    ],
    current: WORK,
    adding: false,
    signInAvailable: false,
    signIn: 'idle',
    duplicate: null,
    damaged: false,
    recoverable: 0,
    checkUsage: false,
    usageAvailable: true,
    ...over,
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

  it('adds each account’s usage under it and when it was checked, while the check is on', async () => {
    const now = Date.now()
    const usage = {
      session: { percent: 42, resetsAt: now + 3_600_000 },
      weekly: { percent: 18, resetsAt: now + 3 * 86_400_000 },
      checkedAt: now - 3 * 60_000,
    }
    await open({
      checkUsage: true,
      accounts: [
        {
          id: 'default',
          email: 'me@example.com',
          signedOut: false,
          enabled: true,
          sameAs: null,
          usage: null,
        },
        {
          id: WORK,
          email: 'work@example.com',
          signedOut: false,
          enabled: true,
          sameAs: null,
          usage,
        },
      ],
    })
    const work = await screen.findByRole('menuitemradio', { name: /work@example.com/ })
    expect(work).toHaveTextContent(/Session 42% · Weekly 18% · pace 57% · resets \w+/)
    expect(screen.getByText(/^Usage checked 3 min/)).toBeInTheDocument()
  })

  it('leaves out an account that is turned off', async () => {
    await open({
      current: 'default',
      accounts: [
        {
          id: 'default',
          email: 'me@example.com',
          signedOut: false,
          enabled: true,
          sameAs: null,
          usage: null,
        },
        {
          id: WORK,
          email: 'work@example.com',
          signedOut: false,
          enabled: false,
          sameAs: null,
          usage: null,
        },
      ],
    })
    await screen.findByRole('menuitemradio', { name: /me@example.com/ })
    expect(screen.queryByRole('menuitemradio', { name: /work@example.com/ })).toBeNull()
  })

  it('shows no usage and no checked line while the check is off', async () => {
    await open()
    await screen.findByRole('menuitemradio', { name: /work@example.com/ })
    expect(screen.queryByText(/Session/)).toBeNull()
    expect(screen.queryByText(/Usage checked/)).toBeNull()
  })

  it('opens the Claude accounts settings page', async () => {
    const openSettings = vi.fn()
    useUIStore.setState({ openSettings })
    await open()
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Manage accounts…' }))
    expect(openSettings).toHaveBeenCalledWith('claudeAccounts')
  })
})
