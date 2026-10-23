import '@testing-library/jest-dom/vitest'
import type { ClaudeAccountsState } from '@shared/claudeAccounts/claudeAccounts'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { ClaudeAccountsSection } from './ClaudeAccountsSection'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const WORK = 'a'.repeat(16)
const SPARE = 'b'.repeat(16)

const state = (over: Partial<ClaudeAccountsState> = {}): ClaudeAccountsState => ({
  accounts: [
    { id: 'default', email: 'me@example.com', signedOut: false, enabled: true, usage: null },
    { id: WORK, email: 'work@example.com', signedOut: false, enabled: true, usage: null },
    { id: SPARE, email: 'spare@example.com', signedOut: false, enabled: true, usage: null },
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

describe('ClaudeAccountsSection', () => {
  it('lists the accounts, marking the default and the one new sessions use', async () => {
    show(state())
    render(<ClaudeAccountsSection />)
    expect(await screen.findByText('work@example.com')).toBeInTheDocument()
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('me@example.com')
    expect(rows[0]).toHaveTextContent('Default')
    expect(rows[1]).toHaveTextContent('Active')
    expect(rows[2]).toHaveTextContent('spare@example.com')
  })

  it('names a default account without a known login', async () => {
    show(
      state({
        accounts: [{ id: 'default', email: null, signedOut: false, enabled: true, usage: null }],
        current: 'default',
      }),
    )
    render(<ClaudeAccountsSection />)
    expect(await screen.findByText('Default account')).toBeInTheDocument()
  })

  it('asks before removing the active account, and removes it only on the confirm', async () => {
    show(state())
    render(<ClaudeAccountsSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove work@example.com' }))
    expect(window.ostia.claudeAccounts.remove).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Remove work@example.com?')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(window.ostia.claudeAccounts.remove).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await userEvent.click(screen.getByRole('button', { name: 'Remove work@example.com' }))
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    )
    expect(window.ostia.claudeAccounts.remove).toHaveBeenCalledWith(WORK)
  })

  it('says so when a Claude session still runs on the account', async () => {
    show(state())
    vi.mocked(window.ostia.claudeAccounts.remove).mockResolvedValueOnce('running')
    render(<ClaudeAccountsSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove work@example.com' }))
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    )
    expect(await screen.findByText(/still running on this account/)).toBeInTheDocument()
  })

  it('gives every account the same actions: switch unless active, remove unless default', async () => {
    show(state())
    render(<ClaudeAccountsSection />)
    await screen.findByText('spare@example.com')
    const [first, active, spare] = screen.getAllByRole('listitem')
    expect(
      within(first).getByRole('button', { name: 'Switch to me@example.com' }),
    ).toBeInTheDocument()
    expect(within(first).queryByRole('button', { name: /^Remove/ })).toBeNull()
    expect(within(active).queryByRole('button', { name: /^Switch to/ })).toBeNull()
    expect(within(active).getByRole('button', { name: 'Remove work@example.com' })).toBeVisible()
    await userEvent.click(
      within(spare).getByRole('button', { name: 'Switch to spare@example.com' }),
    )
    expect(window.ostia.claudeAccounts.use).toHaveBeenCalledWith(SPARE)
    await userEvent.click(within(spare).getByRole('button', { name: 'Remove spare@example.com' }))
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    )
    expect(window.ostia.claudeAccounts.remove).toHaveBeenCalledWith(SPARE)
  })

  it('adds in the active workspace, and waits while a sign-in is open', async () => {
    useWorkspacesStore.setState({ activeWorkspaceId: 'ws-9' })
    const view = show(state())
    render(<ClaudeAccountsSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }))
    expect(window.ostia.claudeAccounts.add).toHaveBeenCalledWith('ws-9')
    view.push(state({ adding: true }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled())
    expect(screen.getByText(/Sign in to the account in the new terminal tab/)).toBeInTheDocument()
  })

  it('says why nothing opened when there is no plain terminal workspace', async () => {
    show(state())
    vi.mocked(window.ostia.claudeAccounts.add).mockResolvedValueOnce('no-workspace')
    render(<ClaudeAccountsSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }))
    expect(await screen.findByText(/not sandboxed or scratch/)).toBeInTheDocument()
  })

  it('says, without a warning tone, that the account signed in is already added', async () => {
    show(state({ duplicate: 'work@example.com' }))
    render(<ClaudeAccountsSection />)
    const note = await screen.findByText('work@example.com is already added.')
    expect(note.closest('[role="alert"]')?.className).not.toContain('warn')
  })

  it('offers Start fresh and blocks Add while the list is damaged', async () => {
    show(state({ damaged: true }))
    render(<ClaudeAccountsSection />)
    expect(await screen.findByRole('button', { name: 'Add' })).toBeDisabled()
    vi.mocked(window.ostia.claudeAccounts.recover).mockResolvedValueOnce(2)
    await userEvent.click(screen.getByRole('button', { name: 'Start fresh' }))
    expect(window.ostia.claudeAccounts.recover).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByText('Brought back 2 accounts that were still signed in.'),
    ).toBeInTheDocument()
  })

  it('offers to bring back sign-ins that are on disk but not in the list, without blocking Add', async () => {
    show(state({ recoverable: 2 }))
    render(<ClaudeAccountsSection />)
    expect(await screen.findByText(/2 signed-in accounts are on this computer/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Bring back' }))
    expect(window.ostia.claudeAccounts.recover).toHaveBeenCalledTimes(1)
  })

  it('uses the singular for one account to bring back and one brought back', async () => {
    show(state({ recoverable: 1 }))
    vi.mocked(window.ostia.claudeAccounts.recover).mockResolvedValueOnce(1)
    render(<ClaudeAccountsSection />)
    expect(await screen.findByText(/^1 signed-in account is on this computer/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Bring back' }))
    expect(
      await screen.findByText('Brought back 1 account that was still signed in.'),
    ).toBeInTheDocument()
  })

  it('turns the usage check on from its switch and shows each account’s usage', async () => {
    const now = Date.now()
    show(
      state({
        checkUsage: true,
        accounts: [
          { id: 'default', email: 'me@example.com', signedOut: false, enabled: true, usage: null },
          {
            id: WORK,
            email: 'work@example.com',
            signedOut: false,
            enabled: true,
            usage: {
              session: { percent: 91, resetsAt: now + 1_800_000 },
              weekly: { percent: 67, resetsAt: now + 2 * 86_400_000 },
              checkedAt: now - 9 * 3_600_000,
            },
          },
        ],
      }),
    )
    render(<ClaudeAccountsSection />)
    const row = (await screen.findByText('work@example.com')).closest('li') as HTMLElement
    expect(row).toHaveTextContent(/Session 91% · Weekly 67% · pace 71% · resets \w+ · 9 hr\. ago/)
    await userEvent.click(screen.getByRole('switch', { name: 'Check usage' }))
    expect(window.ostia.claudeAccounts.setCheckUsage).toHaveBeenCalledWith(false)
  })

  it('has no usage switch where usage cannot be checked', async () => {
    show(state({ usageAvailable: false }))
    render(<ClaudeAccountsSection />)
    await screen.findByText('work@example.com')
    expect(screen.queryByRole('switch', { name: 'Check usage' })).toBeNull()
  })

  it('turns an account off and on from its switch; an off account has no Switch to', async () => {
    show(
      state({
        accounts: [
          { id: 'default', email: 'me@example.com', signedOut: false, enabled: true, usage: null },
          { id: WORK, email: 'work@example.com', signedOut: false, enabled: true, usage: null },
          { id: SPARE, email: 'spare@example.com', signedOut: false, enabled: false, usage: null },
        ],
      }),
    )
    render(<ClaudeAccountsSection />)
    const spare = (await screen.findByText('spare@example.com')).closest('li') as HTMLElement
    expect(spare).toHaveTextContent('Off')
    expect(within(spare).queryByRole('button', { name: /^Switch to/ })).toBeNull()
    await userEvent.click(within(spare).getByRole('switch', { name: 'Use spare@example.com' }))
    expect(window.ostia.claudeAccounts.setEnabled).toHaveBeenCalledWith(SPARE, true)
  })

  it('keeps the Default and the current account on, with the switch disabled', async () => {
    show(state())
    render(<ClaudeAccountsSection />)
    await screen.findByText('work@example.com')
    expect(screen.getByRole('switch', { name: 'Use me@example.com' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.getByRole('switch', { name: 'Use work@example.com' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.getByRole('switch', { name: 'Use spare@example.com' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('says what the accounts share and that other accounts’ changes are replaced', async () => {
    show(state())
    render(<ClaudeAccountsSection />)
    expect(await screen.findByText('What accounts share')).toBeInTheDocument()
    expect(screen.getByText(/replaced by the Default ones at its next start/)).toBeInTheDocument()
  })
  describe('sign-in', () => {
    const available = (over: Partial<ClaudeAccountsState> = {}) =>
      state({ signInAvailable: true, ...over })

    it('Add opens the sign-in dialog instead of a terminal tab where sign-in is available', async () => {
      const user = userEvent.setup()
      show(available({ signIn: 'waiting' }))
      render(<ClaudeAccountsSection />)
      await screen.findByText('work@example.com')
      await user.click(screen.getByRole('button', { name: 'Add' }))
      expect(window.ostia.claudeAccounts.beginSignIn).toHaveBeenCalledWith(null)
      expect(window.ostia.claudeAccounts.add).not.toHaveBeenCalled()
      expect(await screen.findByText('Sign in to Claude in your browser')).toBeInTheDocument()
    })

    it('Add still opens a terminal tab where sign-in is not available', async () => {
      const user = userEvent.setup()
      show(state())
      render(<ClaudeAccountsSection />)
      await screen.findByText('work@example.com')
      await user.click(screen.getByRole('button', { name: 'Add' }))
      expect(window.ostia.claudeAccounts.add).toHaveBeenCalled()
      expect(window.ostia.claudeAccounts.beginSignIn).not.toHaveBeenCalled()
    })

    it('offers Sign in again on a signed-out account and signs that account in', async () => {
      const user = userEvent.setup()
      show(
        available({
          signIn: 'waiting',
          accounts: [
            {
              id: 'default',
              email: 'me@example.com',
              signedOut: false,
              enabled: true,
              usage: null,
            },
            { id: SPARE, email: 'spare@example.com', signedOut: true, enabled: true, usage: null },
          ],
          current: 'default',
        }),
      )
      render(<ClaudeAccountsSection />)
      const row = (await screen.findByText('spare@example.com')).closest('li') as HTMLElement
      expect(row).toHaveTextContent('Signed out')
      await user.click(within(row).getByRole('button', { name: 'Sign in again' }))
      expect(window.ostia.claudeAccounts.beginSignIn).toHaveBeenCalledWith(SPARE)
    })

    it('shows no Sign in again on an account that is signed in', async () => {
      show(available())
      render(<ClaudeAccountsSection />)
      await screen.findByText('work@example.com')
      expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull()
    })

    it('does not open the dialog when another sign-in is open', async () => {
      const user = userEvent.setup()
      vi.mocked(window.ostia.claudeAccounts.beginSignIn).mockResolvedValueOnce('busy')
      show(available())
      render(<ClaudeAccountsSection />)
      await screen.findByText('work@example.com')
      await user.click(screen.getByRole('button', { name: 'Add' }))
      expect(await screen.findByText('Another sign-in is still open.')).toBeInTheDocument()
      expect(screen.queryByText('Sign in to Claude in your browser')).toBeNull()
    })
  })
})
