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
    { id: 'default', email: 'me@example.com' },
    { id: WORK, email: 'work@example.com' },
    { id: SPARE, email: 'spare@example.com' },
  ],
  current: WORK,
  adding: false,
  duplicate: null,
  damaged: false,
  recoverable: 0,
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
    show(state({ accounts: [{ id: 'default', email: null }], current: 'default' }))
    render(<ClaudeAccountsSection />)
    expect(await screen.findByText('Default account')).toBeInTheDocument()
  })

  it('asks before removing the active account, and removes it only on the confirm', async () => {
    show(state())
    render(<ClaudeAccountsSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(window.ostia.claudeAccounts.remove).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Remove work@example.com?')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(window.ostia.claudeAccounts.remove).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    )
    expect(window.ostia.claudeAccounts.remove).toHaveBeenCalledWith(WORK)
  })

  it('says so when a Claude session still runs on the account', async () => {
    show(state())
    vi.mocked(window.ostia.claudeAccounts.remove).mockResolvedValueOnce('running')
    render(<ClaudeAccountsSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    )
    expect(await screen.findByText(/still running on this account/)).toBeInTheDocument()
  })

  it('switches to or removes another account from its menu', async () => {
    show(state())
    render(<ClaudeAccountsSection />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Actions for spare@example.com' }),
    )
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Switch to' }))
    expect(window.ostia.claudeAccounts.use).toHaveBeenCalledWith(SPARE)
    await userEvent.click(screen.getByRole('button', { name: 'Actions for spare@example.com' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }))
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    )
    expect(window.ostia.claudeAccounts.remove).toHaveBeenCalledWith(SPARE)
  })

  it('cannot remove the default account', async () => {
    show(state())
    render(<ClaudeAccountsSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for me@example.com' }))
    expect(await screen.findByRole('menuitem', { name: 'Switch to' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Remove' })).toBeNull()
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

  it('says what the accounts share and that other accounts’ changes are replaced', async () => {
    show(state())
    render(<ClaudeAccountsSection />)
    expect(await screen.findByText('What accounts share')).toBeInTheDocument()
    expect(screen.getByText(/replaced by the Default ones at its next start/)).toBeInTheDocument()
  })
})
