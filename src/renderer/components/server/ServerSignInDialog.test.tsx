import '@testing-library/jest-dom/vitest'
import type { ServerOffer, ServerStatus } from '@shared/server/serverApi'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerSignInDialog } from './ServerSignInDialog'

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
  sync: true,
  push: true,
  invite: true,
  github: true,
}

function offering(auth: Pick<ServerOffer, 'invite' | 'github'>): void {
  vi.mocked(window.ostia.server.status).mockResolvedValue(SIGNED_OUT)
  vi.mocked(window.ostia.server.info).mockResolvedValue({ ok: true, offer: { ...OFFER, ...auth } })
}

afterEach(cleanup)

describe('ServerSignInDialog', () => {
  it('leads with the invite code field and offers no GitHub button when the server has no GitHub', async () => {
    offering({ invite: true, github: false })
    render(<ServerSignInDialog open onClose={() => undefined} />)
    expect(await screen.findByRole('textbox', { name: 'Invite code' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use an invite code' })).toBeNull()
  })

  it('leads with GitHub and keeps the invite code behind its link when the server has both', async () => {
    offering({ invite: true, github: true })
    render(<ServerSignInDialog open onClose={() => undefined} />)
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Invite code' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Use an invite code' }))
    expect(await screen.findByRole('textbox', { name: 'Invite code' })).toBeVisible()
  })
})
