import type { BrowserStorageSnapshot } from '@shared/browserStorage'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserStoragePanel } from './BrowserStoragePanel'
import { TooltipProvider } from './ui/tooltip'

const PANE = 'browser-pane'

const snapshot: BrowserStorageSnapshot = {
  origin: 'https://shop.test',
  cookies: [
    {
      name: 'sid',
      value: 'abc123',
      domain: 'shop.test',
      path: '/',
      hostOnly: true,
      expires: null,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    },
    {
      name: 'theme',
      value: 'dark',
      domain: '.shop.test',
      path: '/app',
      hostOnly: false,
      expires: 2_000_000_000,
      httpOnly: false,
      secure: false,
      sameSite: 'unspecified',
    },
  ],
  local: [
    { key: 'cart', value: '[1,2]' },
    { key: 'user', value: 'ada' },
  ],
  session: [{ key: 'step', value: '2' }],
}

function renderPanel(onClose = vi.fn(), shared = false) {
  render(
    <TooltipProvider>
      <BrowserStoragePanel paneId={PANE} shared={shared} refreshKey={0} onClose={onClose} />
    </TooltipProvider>,
  )
  return { onClose }
}

beforeEach(() => {
  vi.mocked(window.ostia.browser.storageRead).mockResolvedValue({ ok: true, snapshot })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BrowserStoragePanel', () => {
  it('reads this pane storage and lists cookies with their attributes', async () => {
    renderPanel()
    const table = await screen.findByRole('table', { name: 'Cookies' })
    expect(window.ostia.browser.storageRead).toHaveBeenCalledWith(PANE)
    const sid = within(table).getByText('sid').closest('tr') as HTMLElement
    expect(within(sid).getByText('abc123')).toBeInTheDocument()
    expect(within(sid).getByText('shop.test')).toBeInTheDocument()
    expect(within(sid).getByText('Session')).toBeInTheDocument()
    expect(within(sid).getByText('lax')).toBeInTheDocument()
    expect(within(sid).getAllByRole('img', { name: 'Yes' })).toHaveLength(2)
    const theme = within(table).getByText('theme').closest('tr') as HTMLElement
    expect(within(theme).queryAllByRole('img', { name: 'Yes' })).toHaveLength(0)
    expect(within(theme).getByText('/app')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Cookies 2/ })).toBeInTheDocument()
  })

  it('shows local and session storage with the page origin', async () => {
    renderPanel()
    await screen.findByRole('table', { name: 'Cookies' })
    await userEvent.click(screen.getByRole('tab', { name: /Local storage/ }))
    const local = screen.getByRole('table', { name: 'Local storage' })
    expect(within(local).getByText('cart')).toBeInTheDocument()
    expect(within(local).getByText('[1,2]')).toBeInTheDocument()
    expect(screen.getByText('Origin: https://shop.test')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /Session storage/ }))
    expect(
      within(screen.getByRole('table', { name: 'Session storage' })).getByText('step'),
    ).toBeInTheDocument()
  })

  it('filters rows by name or value', async () => {
    renderPanel()
    await screen.findByRole('table', { name: 'Cookies' })
    await userEvent.type(screen.getByRole('textbox', { name: 'Filter storage' }), 'dark')
    const table = screen.getByRole('table', { name: 'Cookies' })
    expect(within(table).queryByText('sid')).not.toBeInTheDocument()
    expect(within(table).getByText('theme')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: 'Filter storage' }), 'zzz')
    expect(within(table).getByText('Nothing matches “darkzzz”.')).toBeInTheDocument()
  })

  it('deletes one entry and reloads', async () => {
    renderPanel()
    await screen.findByRole('table', { name: 'Cookies' })
    await userEvent.click(screen.getByRole('button', { name: 'Delete sid' }))
    expect(window.ostia.browser.storageRemove).toHaveBeenCalledWith(PANE, {
      kind: 'cookies',
      cookie: snapshot.cookies[0],
    })
    await waitFor(() => expect(window.ostia.browser.storageRead).toHaveBeenCalledTimes(2))
  })

  it('edits a value in a dialog and saves it to the page', async () => {
    renderPanel()
    await screen.findByRole('table', { name: 'Cookies' })
    await userEvent.click(screen.getByRole('tab', { name: /Local storage/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Edit user' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit user' })
    const value = within(dialog).getByRole('textbox', { name: 'Value' })
    await userEvent.clear(value)
    await userEvent.type(value, 'grace')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(window.ostia.browser.storageSet).toHaveBeenCalledWith(PANE, {
      kind: 'local',
      key: 'user',
      value: 'grace',
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps a cookie flags when its value is edited', async () => {
    renderPanel()
    await screen.findByRole('table', { name: 'Cookies' })
    await userEvent.click(screen.getByRole('button', { name: 'Edit sid' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit sid' })
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Value' }), 'x')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(window.ostia.browser.storageSet).toHaveBeenCalledWith(PANE, {
      kind: 'cookies',
      cookie: { ...snapshot.cookies[0], value: 'abc123x' },
    })
  })

  it('clears everything only after the human confirms', async () => {
    renderPanel()
    await screen.findByRole('table', { name: 'Cookies' })
    await userEvent.click(screen.getByRole('tab', { name: /Session storage/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    const dialog = await screen.findByRole('dialog', { name: 'Clear session storage?' })
    expect(within(dialog).getByText(/https:\/\/shop\.test/)).toBeInTheDocument()
    expect(window.ostia.browser.storageClear).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear' }))
    expect(window.ostia.browser.storageClear).toHaveBeenCalledWith(PANE, 'session')
  })

  it('warns that clearing the shared profile signs out every tab that uses it, and still asks first', async () => {
    renderPanel(vi.fn(), true)
    await screen.findByRole('table', { name: 'Cookies' })
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    const cookies = await screen.findByRole('dialog', { name: 'Clear all cookies?' })
    expect(within(cookies).getByText(/for every browser tab that uses it/)).toBeInTheDocument()
    expect(window.ostia.browser.storageClear).not.toHaveBeenCalled()
    await userEvent.click(within(cookies).getByRole('button', { name: 'Cancel' }))

    await userEvent.click(screen.getByRole('tab', { name: /Local storage/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    const local = await screen.findByRole('dialog', { name: 'Clear local storage?' })
    expect(within(local).getByText(/for every browser tab that uses it/)).toBeInTheDocument()
    await userEvent.click(within(local).getByRole('button', { name: 'Clear' }))
    expect(window.ostia.browser.storageClear).toHaveBeenCalledWith(PANE, 'local')
  })

  it('copies a value to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderPanel()
    await screen.findByRole('table', { name: 'Cookies' })
    await userEvent.click(screen.getByRole('button', { name: 'Copy the value of sid' }))
    expect(writeText).toHaveBeenCalledWith('abc123')
    expect(await screen.findByText('Copied the value of sid.')).toBeInTheDocument()
  })

  it('reports a failed write and a failed read', async () => {
    vi.mocked(window.ostia.browser.storageRemove).mockResolvedValueOnce({
      ok: false,
      error: 'storage-failed',
    })
    renderPanel()
    await screen.findByRole('table', { name: 'Cookies' })
    await userEvent.click(screen.getByRole('button', { name: 'Delete sid' }))
    expect(
      await screen.findByText('Could not change storage (storage-failed).'),
    ).toBeInTheDocument()
    vi.mocked(window.ostia.browser.storageRead).mockResolvedValue({
      ok: false,
      error: 'browser-not-ready',
    })
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('browser-not-ready')
  })

  it('shows an empty state and closes', async () => {
    vi.mocked(window.ostia.browser.storageRead).mockResolvedValue({
      ok: true,
      snapshot: { origin: 'https://shop.test', cookies: [], local: [], session: [] },
    })
    const { onClose } = renderPanel()
    expect(await screen.findByText('This browser pane has no cookies.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Close storage' }))
    expect(onClose).toHaveBeenCalled()
  })
})
