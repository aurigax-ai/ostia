import '@testing-library/jest-dom/vitest'
import type { ShareView } from '@shared/artifacts/shares'
import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/stores/app/uiStore'
import { useSharesStore } from '@/stores/files/sharesStore'
import { renderSettled } from '../../../../test/render'
import { SharesSection } from './SharesSection'

const BASE: ShareView = {
  id: 'abc',
  url: 'https://abc.shares.test/',
  mode: 'link',
  size: 2048,
  views: 3,
  expiresAt: Date.UTC(2027, 0, 5),
  uploaded: true,
  expired: false,
  name: 'plan.html',
  source: '/data/plan.html',
  linkable: true,
}

function shares() {
  return vi.mocked(window.ostia.shares)
}

function listReturns(list: ShareView[]): void {
  shares().status.mockResolvedValue({
    state: 'ready',
    allowNever: false,
    allowPublic: false,
    maxBytes: 1,
  })
  shares().list.mockResolvedValue({ ok: true, shares: list })
}

describe('Settings › Shared artifacts', () => {
  beforeEach(() => {
    useSharesStore.setState({ availability: null, shares: [], error: null, loaded: false })
    listReturns([BASE])
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('SHR-C70 lists what was shared with its mode, views and expiry', async () => {
    listReturns([
      BASE,
      { ...BASE, id: 'old', name: null, mode: 'password', views: 1, expired: true },
      { ...BASE, id: 'half', name: 'half.html', uploaded: false, views: 0 },
    ])
    await renderSettled(<SharesSection />)
    const rows = await screen.findAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('plan.html')
    expect(rows[0]).toHaveTextContent('Link · 2 kB · 3 views · Expires 1/5/2027')
    expect(rows[1]).toHaveTextContent('https://abc.shares.test/')
    expect(rows[1]).toHaveTextContent('Password · 2 kB · 1 view · Expired')
    expect(within(rows[1] as HTMLElement).queryByRole('button', { name: 'Copy link' })).toBeNull()
    expect(rows[2]).toHaveTextContent('Upload unfinished')
  })

  it('SHR-C71 says when nothing is shared yet', async () => {
    listReturns([])
    await renderSettled(<SharesSection />)
    expect(await screen.findByText(/Nothing published yet/)).toBeInTheDocument()
  })

  it('SHR-C72 opens the sign-in dialog without leaving Shared artifacts', async () => {
    shares().status.mockResolvedValue({ state: 'signed-out' })
    shares().list.mockResolvedValue({ ok: false, error: 'signed-out' })
    await renderSettled(<SharesSection />)
    expect(
      await screen.findByText(
        'Sign in to your Ostia account to publish files and manage what you shared.',
      ),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeInTheDocument()
    expect(useUIStore.getState().settingsSection).not.toBe('sync')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('SHR-C73 copies the link through main and never shows it', async () => {
    await renderSettled(<SharesSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Copy link' }))
    expect(shares().copyLink).toHaveBeenCalledWith('abc')
    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('#k=')
  })

  it('SHR-C74 deletes a share and drops its row, or says why it could not', async () => {
    shares().remove.mockResolvedValueOnce({ ok: false, error: 'unreachable' })
    await renderSettled(<SharesSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(shares().remove).toHaveBeenCalledWith('abc')
    expect(await screen.findByText(/Could not reach the server/)).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('SHR-C75 explains a server that cannot be reached and a server with publishing off', async () => {
    shares().list.mockResolvedValue({ ok: false, error: 'unreachable' })
    const view = await renderSettled(<SharesSection />)
    expect(await screen.findByText(/Could not reach the server/)).toBeInTheDocument()
    view.unmount()
    useSharesStore.setState({ availability: null, error: null })
    shares().status.mockResolvedValue({ state: 'off' })
    shares().list.mockResolvedValue({ ok: true, shares: [] })
    await renderSettled(<SharesSection />)
    expect(await screen.findByText('This server has publishing turned off.')).toBeInTheDocument()
  })
})
