import type { ServerOffer, ServerStatus } from '@shared/server/serverApi'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServerSection } from './ServerSection'

const SIGNED_OUT: ServerStatus = {
  url: 'https://ostia.example.com',
  host: 'ostia.example.com',
  signedIn: false,
  provider: null,
  deviceName: null,
}

const OFFER: ServerOffer = {
  relay: true,
  publish: true,
  sync: false,
  push: false,
  invite: true,
  github: false,
}

function server() {
  return vi.mocked(window.ostia.server)
}

function serverReturns(status: ServerStatus, offer: ServerOffer = OFFER): void {
  server().status.mockResolvedValue(status)
  server().info.mockResolvedValue({ ok: true, offer })
}

describe('Settings › Server', () => {
  beforeEach(() => {
    serverReturns(SIGNED_OUT)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('SVA-C44 asks for the address and offers nothing else until one is set', async () => {
    serverReturns({ ...SIGNED_OUT, url: null, host: null })
    render(<ServerSection />)
    expect(await screen.findByPlaceholderText("Enter your server's address")).toHaveValue('')
    expect(screen.queryByText('What this server offers')).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Invite code' })).toBeNull()
    expect(server().info).not.toHaveBeenCalled()
  })

  it('SVA-C45 saves the address the human commits and shows a refusal from main', async () => {
    const user = userEvent.setup()
    server().setUrl.mockResolvedValueOnce({ ok: false, error: 'invalid-url' })
    render(<ServerSection />)
    const field = await screen.findByRole('textbox', { name: 'Server address' })
    await user.clear(field)
    await user.type(field, 'nope{Enter}')
    expect(server().setUrl).toHaveBeenCalledWith('nope')
    expect(await screen.findByRole('alert')).toHaveTextContent(/Enter a web address/)
  })

  it('SVA-C46 lists what the server offers', async () => {
    render(<ServerSection />)
    expect(await screen.findByText('Phone relay · Publishing')).toBeInTheDocument()
  })

  it('SVA-C47 explains an unreachable server', async () => {
    server().info.mockResolvedValue({ ok: false, error: 'unreachable' })
    render(<ServerSection />)
    expect(await screen.findByText(/Could not reach the server/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Invite code' })).toBeNull()
  })

  it('SVA-C48 signs in with an invite code and clears the field', async () => {
    const user = userEvent.setup()
    render(<ServerSection />)
    const code = await screen.findByRole('textbox', { name: 'Invite code' })
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
    await user.type(code, 'ABCD-EFGH')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(server().signInWithInvite).toHaveBeenCalledWith('ABCD-EFGH')
    await waitFor(() => expect(code).toHaveValue(''))
  })

  it('SVA-C49 says why an invite code was refused', async () => {
    const user = userEvent.setup()
    server().signInWithInvite.mockResolvedValue({ ok: false, error: 'invalid-invite' })
    render(<ServerSection />)
    await user.type(await screen.findByRole('textbox', { name: 'Invite code' }), 'bad{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent(/invite code is not valid/)
  })

  it('SVA-C50 shows the signed-in device and signs out', async () => {
    const user = userEvent.setup()
    serverReturns({ ...SIGNED_OUT, signedIn: true, provider: 'github', deviceName: 'Desk' })
    render(<ServerSection />)
    expect(await screen.findByText(/^Signed in as Desk with GitHub\./)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Invite code' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Server address' })).toBeNull()
    expect(screen.getByText('https://ostia.example.com')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(server().signOut).toHaveBeenCalled()
  })

  it('SVA-C51 follows status changes pushed by main', async () => {
    let push: (status: ServerStatus) => void = () => {}
    server().onChanged.mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    render(<ServerSection />)
    await screen.findByRole('textbox', { name: 'Invite code' })
    act(() => push({ ...SIGNED_OUT, signedIn: true, provider: 'invite', deviceName: 'Desk' }))
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })
})

describe('signing in with GitHub', () => {
  beforeEach(() => {
    serverReturns(SIGNED_OUT, { ...OFFER, invite: false, github: true })
    server().githubStart.mockResolvedValue({
      ok: true,
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('SVA-C52 shows the user code and the link while it waits, and opens the link from main', async () => {
    const user = userEvent.setup()
    server().githubPoll.mockResolvedValue({ state: 'pending' })
    render(<ServerSection />)
    await user.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }))
    expect(await screen.findByText('ABCD-1234')).toBeInTheDocument()
    expect(screen.getByText('Waiting for you to finish on GitHub.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open github.com/login/device' }))
    expect(server().openVerification).toHaveBeenCalled()
  })

  it('SVA-C53 polls until main reports it is done and then stops showing the code', async () => {
    const user = userEvent.setup()
    server()
      .githubPoll.mockResolvedValueOnce({ state: 'pending' })
      .mockResolvedValue({ state: 'done' })
    render(<ServerSection />)
    await user.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }))
    await waitFor(() => expect(screen.queryByText('ABCD-1234')).toBeNull(), { timeout: 6000 })
    expect(server().githubPoll).toHaveBeenCalledTimes(2)
  })

  it('SVA-C54 shows a refusal and offers to start again', async () => {
    const user = userEvent.setup()
    server().githubPoll.mockResolvedValue({ state: 'error', error: 'denied' })
    render(<ServerSection />)
    await user.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }))
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      'GitHub sign-in was refused.',
    )
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument()
  })

  it('SVA-C55 cancels the flow in main', async () => {
    const user = userEvent.setup()
    server().githubPoll.mockResolvedValue({ state: 'pending' })
    render(<ServerSection />)
    await user.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(server().githubCancel).toHaveBeenCalled()
    expect(screen.queryByText('ABCD-1234')).toBeNull()
  })
})

describe('leaving the server', () => {
  beforeEach(() => {
    serverReturns(SIGNED_OUT)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('SYA-C127 asks before leaving from this computer’s row and then signs out', async () => {
    const user = userEvent.setup()
    serverReturns({ ...SIGNED_OUT, signedIn: true, provider: 'github', deviceName: 'Desk' })
    server().devices.mockResolvedValue({
      ok: true,
      devices: [{ id: 'me', name: 'Desk', current: true, lastSeen: 0, createdAt: Date.now() }],
    })
    render(<ServerSection />)
    await user.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(server().signOut).not.toHaveBeenCalled()
    expect(
      await screen.findByText(
        'Signs this computer out of the server. Other devices stay signed in.',
      ),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove this computer' }))
    expect(server().signOut).toHaveBeenCalledTimes(1)
  })

  it('SYA-C128 says the server still lists this computer when it could not delete the device', async () => {
    const user = userEvent.setup()
    serverReturns({ ...SIGNED_OUT, signedIn: true, provider: 'github', deviceName: 'Desk' })
    const listeners: Array<(status: ServerStatus) => void> = []
    server().onChanged.mockImplementation((cb) => {
      listeners.push(cb)
      return () => {}
    })
    server().signOut.mockImplementation(async () => {
      act(() => {
        for (const listener of listeners) listener(SIGNED_OUT)
      })
      return { ok: true, deviceKept: true }
    })
    render(<ServerSection />)
    await user.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(
      await screen.findByText(/The server keeps this computer in its device list/),
    ).toBeInTheDocument()
  })
})
