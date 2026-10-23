import '@testing-library/jest-dom/vitest'
import type { ClaudeAccountsState } from '@shared/claudeAccounts/claudeAccounts'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSignInDialog } from './ClaudeSignInDialog'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const WORK = 'a'.repeat(16)
const ACCOUNT = { id: WORK, email: 'work@example.com', signedOut: true, usage: null }

const state = (signIn: ClaudeAccountsState['signIn']): ClaudeAccountsState => ({
  accounts: [{ id: 'default', email: 'me@example.com', signedOut: false, usage: null }, ACCOUNT],
  current: 'default',
  adding: false,
  signInAvailable: true,
  signIn,
  duplicate: null,
  damaged: false,
  recoverable: 0,
  checkUsage: false,
  usageAvailable: true,
})

function show(first: ClaudeAccountsState['signIn']): (next: ClaudeAccountsState['signIn']) => void {
  let push: (s: ClaudeAccountsState) => void = () => {}
  vi.mocked(window.ostia.claudeAccounts.state).mockResolvedValue(state(first))
  vi.mocked(window.ostia.claudeAccounts.onChange).mockImplementation((cb) => {
    push = cb
    return () => {}
  })
  return (next) => act(() => push(state(next)))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ClaudeSignInDialog', () => {
  it('shows the page button, the waiting line and the code field', async () => {
    show('waiting')
    render(<ClaudeSignInDialog account={null} onClose={() => {}} />)
    expect(await screen.findByText('Sign in to Claude in your browser')).toBeInTheDocument()
    expect(screen.getByText('Waiting for the browser…')).toBeInTheDocument()
    expect(
      screen.getByLabelText('Paste the code, or the address the browser was sent to'),
    ).toBeInTheDocument()
  })

  it('opens the sign-in page through main on request', async () => {
    const user = userEvent.setup()
    show('waiting')
    render(<ClaudeSignInDialog account={null} onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Open sign-in page' }))
    expect(window.ostia.claudeAccounts.openSignIn).toHaveBeenCalled()
  })

  it('keeps Submit off until a code is typed and then sends it', async () => {
    const user = userEvent.setup()
    show('waiting')
    render(<ClaudeSignInDialog account={null} onClose={() => {}} />)
    const submit = await screen.findByRole('button', { name: 'Submit' })
    expect(submit).toBeDisabled()
    await user.type(
      screen.getByLabelText('Paste the code, or the address the browser was sent to'),
      ' abcdefghijklmnop0123 ',
    )
    await user.click(submit)
    expect(window.ostia.claudeAccounts.submitSignInCode).toHaveBeenCalledWith(
      ' abcdefghijklmnop0123 ',
    )
  })

  it('says so when main refuses the code, and clears it when the human types again', async () => {
    const user = userEvent.setup()
    vi.mocked(window.ostia.claudeAccounts.submitSignInCode).mockResolvedValueOnce('invalid')
    show('waiting')
    render(<ClaudeSignInDialog account={null} onClose={() => {}} />)
    const field = await screen.findByLabelText(
      'Paste the code, or the address the browser was sent to',
    )
    await user.type(field, 'nope')
    await user.click(screen.getByRole('button', { name: 'Submit' }))
    expect(
      await screen.findByText('That is not a sign-in code for this sign-in.'),
    ).toBeInTheDocument()
    await user.type(field, 'x')
    expect(screen.queryByText('That is not a sign-in code for this sign-in.')).toBeNull()
  })

  it('cannot be cancelled or submitted while the account is being signed in', async () => {
    show('working')
    render(<ClaudeSignInDialog account={null} onClose={() => {}} />)
    expect(await screen.findByText('Signing in…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
  })

  it('Cancel stops the sign-in in main and closes', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    show('waiting')
    render(<ClaudeSignInDialog account={null} onClose={onClose} />)
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(window.ostia.claudeAccounts.cancelSignIn).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('closes by itself when the sign-in finishes', async () => {
    const onClose = vi.fn()
    const push = show('waiting')
    render(<ClaudeSignInDialog account={null} onClose={onClose} />)
    await screen.findByText('Waiting for the browser…')
    expect(onClose).not.toHaveBeenCalled()
    push('idle')
    expect(onClose).toHaveBeenCalled()
  })

  it('offers Try again after a failure and starts the same account again', async () => {
    const user = userEvent.setup()
    show('failed')
    render(<ClaudeSignInDialog account={ACCOUNT} onClose={() => {}} />)
    expect(await screen.findByText('Sign-in did not finish. Try again.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(window.ostia.claudeAccounts.beginSignIn).toHaveBeenCalledWith(WORK)
  })

  it('names the account to sign in with after a different account signed in', async () => {
    show('mismatch')
    render(<ClaudeSignInDialog account={ACCOUNT} onClose={() => {}} />)
    expect(
      await screen.findByText('That was a different account. Sign in with work@example.com.'),
    ).toBeInTheDocument()
  })
})
