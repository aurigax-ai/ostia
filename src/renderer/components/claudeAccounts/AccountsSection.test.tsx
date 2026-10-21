import '@testing-library/jest-dom/vitest'
import type { ClaudeAccountsState } from '@shared/claudeAccounts/claudeAccounts'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountsSection } from './AccountsSection'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const WORK = 'a'.repeat(16)
const SPARE = 'b'.repeat(16)

const state = (over: Partial<ClaudeAccountsState> = {}): ClaudeAccountsState => ({
  accounts: [
    { id: 'default', email: 'me@example.com' },
    { id: WORK, email: 'work@example.com' },
    { id: SPARE, email: 'spare@example.com' },
  ],
  current: WORK,
  adding: false,
  duplicate: null,
  ...over,
})

function show(next: ClaudeAccountsState): { push: (s: ClaudeAccountsState) => void } {
  let push: (s: ClaudeAccountsState) => void = () => {}
  vi.mocked(window.ostia.claudeAccounts.state).mockResolvedValue(next)
  vi.mocked(window.ostia.claudeAccounts.onChange).mockImplementation((cb) => {
    push = cb
    return () => {}
  })
  return { push: (s) => act(() => push(s)) }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AccountsSection', () => {
  it('lists the accounts, marking the default and the one new sessions use', async () => {
    show(state())
    render(<AccountsSection />)
    expect(await screen.findByText('work@example.com')).toBeInTheDocument()
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('me@example.com')
    expect(rows[0]).toHaveTextContent('Default')
    expect(rows[1]).toHaveTextContent('Active')
    expect(rows[2]).toHaveTextContent('spare@example.com')
  })

  it('names a default account without a known login', async () => {
    show(state({ accounts: [{ id: 'default', email: null }], current: 'default' }))
    render(<AccountsSection />)
    expect(await screen.findByText('Default account')).toBeInTheDocument()
  })

  it('removes the active account with its own button', async () => {
    show(state())
    render(<AccountsSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(window.ostia.claudeAccounts.remove).toHaveBeenCalledWith(WORK)
  })

  it('switches to or removes another account from its menu', async () => {
    show(state())
    render(<AccountsSection />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Actions for spare@example.com' }),
    )
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Switch to' }))
    expect(window.ostia.claudeAccounts.use).toHaveBeenCalledWith(SPARE)
    await userEvent.click(screen.getByRole('button', { name: 'Actions for spare@example.com' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }))
    expect(window.ostia.claudeAccounts.remove).toHaveBeenCalledWith(SPARE)
  })

  it('cannot remove the default account', async () => {
    show(state())
    render(<AccountsSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for me@example.com' }))
    expect(await screen.findByRole('menuitem', { name: 'Switch to' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Remove' })).toBeNull()
  })

  it('opens the sign-in on Add, and waits while one is open', async () => {
    const view = show(state())
    render(<AccountsSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }))
    expect(window.ostia.claudeAccounts.add).toHaveBeenCalledTimes(1)
    view.push(state({ adding: true }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled())
    expect(screen.getByText(/Sign in to the account in the new terminal tab/)).toBeInTheDocument()
  })

  it('says when the account signed in is already added', async () => {
    show(state({ duplicate: 'work@example.com' }))
    render(<AccountsSection />)
    expect(await screen.findByText('work@example.com is already added.')).toBeInTheDocument()
  })
})
