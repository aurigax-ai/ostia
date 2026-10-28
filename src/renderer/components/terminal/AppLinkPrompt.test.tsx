import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { openAppLink } from '@/lib/terminalLinks/appLinkOpen'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useAppLinkStore } from '@/stores/terminal/appLinkStore'
import { AppLinkPrompt } from './AppLinkPrompt'

let settingsInit: ReturnType<typeof useSettingsStore.getState>

beforeAll(() => {
  settingsInit = useSettingsStore.getState()
})

afterEach(() => {
  cleanup()
  useSettingsStore.setState(settingsInit, true)
  useAppLinkStore.setState({ byPane: {} })
  vi.mocked(window.ostia.openPath.openLink).mockClear()
})

const ask = {
  kind: 'ask',
  url: 'chrome://inspect/#remote-debugging',
  app: 'Google Chrome',
} as const

describe('AppLinkPrompt', () => {
  it('names the app and the full address, and opens only after Open', async () => {
    useAppLinkStore.getState().show('p1', ask)
    render(<AppLinkPrompt paneId="p1" prompt={ask} />)
    const card = screen.getByRole('region', { name: 'Open link in an app' })
    expect(card).toHaveTextContent('Open in Google Chrome?')
    expect(card).toHaveTextContent('chrome://inspect/#remote-debugging')
    expect(window.ostia.openPath.openLink).not.toHaveBeenCalled()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }))
    expect(window.ostia.openPath.openLink).toHaveBeenCalledWith(ask.url, true)
    await vi.waitFor(() => expect(useAppLinkStore.getState().byPane.p1).toBeUndefined())
    expect(useSettingsStore.getState().terminal.allowedAppSchemes).toEqual([])
  })

  it.each([
    ['the Cancel button', 'last'],
    ['the close button', 'first'],
  ] as const)('%s opens nothing', async (_name, which) => {
    useAppLinkStore.getState().show('p1', ask)
    render(<AppLinkPrompt paneId="p1" prompt={ask} />)
    const cancels = screen.getAllByRole('button', { name: 'Cancel' })
    expect(cancels).toHaveLength(2)
    await userEvent.setup().click(which === 'first' ? cancels[0] : cancels[1])
    expect(window.ostia.openPath.openLink).not.toHaveBeenCalled()
    expect(useAppLinkStore.getState().byPane.p1).toBeUndefined()
  })

  it('Don’t ask again for the scheme adds it to the allowed list before opening', async () => {
    render(<AppLinkPrompt paneId="p1" prompt={ask} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: "Don't ask again for chrome:" }))
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(useSettingsStore.getState().terminal.allowedAppSchemes).toEqual(['chrome'])
    expect(window.ostia.openPath.openLink).toHaveBeenCalledWith(ask.url, true)
  })

  it('says that no app opens the scheme and offers no Open button', () => {
    render(<AppLinkPrompt paneId="p1" prompt={{ kind: 'none', url: 'slack://channel?id=1' }} />)
    expect(screen.getByRole('region')).toHaveTextContent('No app opens slack: links')
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
  })

  it('shows the failure when the app did not open the link', async () => {
    vi.mocked(window.ostia.openPath.openLink).mockResolvedValueOnce({ ok: false, error: 'failed' })
    render(<AppLinkPrompt paneId="p1" prompt={ask} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }))
    await vi.waitFor(() => expect(useAppLinkStore.getState().byPane.p1?.kind).toBe('failed'))
  })
})

describe('openAppLink', () => {
  it('asks while the question is on and the scheme is not allowed', async () => {
    await openAppLink('p1', 'obsidian://open?vault=a')
    expect(useAppLinkStore.getState().byPane.p1).toEqual({
      kind: 'ask',
      url: 'obsidian://open?vault=a',
      app: 'Obsidian',
    })
    expect(window.ostia.openPath.openLink).not.toHaveBeenCalled()
  })

  it('opens at once for an allowed scheme and when the question is off', async () => {
    useSettingsStore.getState().setTerminal({ allowedAppSchemes: ['obsidian'] })
    await openAppLink('p1', 'obsidian://open')
    useSettingsStore.getState().setTerminal({ allowedAppSchemes: [], askBeforeOpeningApps: false })
    await openAppLink('p1', 'vscode://file/a')
    expect(window.ostia.openPath.openLink).toHaveBeenCalledTimes(2)
    expect(window.ostia.openPath.openLink).toHaveBeenCalledWith('vscode://file/a', false)
    expect(useAppLinkStore.getState().byPane.p1).toBeUndefined()
  })

  it('falls back to the question when main still wants one', async () => {
    useSettingsStore.getState().setTerminal({ askBeforeOpeningApps: false })
    vi.mocked(window.ostia.openPath.openLink).mockResolvedValueOnce({
      ok: false,
      error: 'not-allowed',
    })
    await openAppLink('p1', 'obsidian://open')
    expect(useAppLinkStore.getState().byPane.p1?.kind).toBe('ask')
  })

  it('says no app opens the link when main finds no handler', async () => {
    vi.mocked(window.ostia.openPath.linkInfo).mockResolvedValueOnce({
      ok: false,
      error: 'no-handler',
    })
    await openAppLink('p1', 'slack://channel?id=1')
    expect(useAppLinkStore.getState().byPane.p1).toEqual({
      kind: 'none',
      url: 'slack://channel?id=1',
    })
  })
})
