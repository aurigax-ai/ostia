import { beforeEach, describe, expect, it, vi } from 'vitest'

const owners = vi.hoisted(() => new Map<unknown, unknown>())
vi.mock('electron', () => ({
  app: { getApplicationNameForProtocol: () => '' },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { fromWebContents: (wc: unknown) => owners.get(wc) ?? null },
}))

const { appLinkInfo, openLink } = await import('./appLinks')

type Deps = Parameters<typeof openLink>[0]
type Event = Parameters<typeof openLink>[1]

const mainFrame = {}
const appSender = { mainFrame }
const appWindow = {}
owners.set(appSender, appWindow)
const fromApp = { sender: appSender, senderFrame: mainFrame } as unknown as Event

const openExternal = vi.fn(async (_href: string) => {})
const startBrowser = vi.fn(async () => true)
let terminal: Record<string, unknown> | undefined
let installed: string[]

function deps(): Deps {
  return {
    appWindows: () => [appWindow] as unknown as Iterable<Electron.BrowserWindow>,
    readSettings: () => ({ terminal }),
    openExternal,
    lookup: {
      platform: 'linux',
      protocolApp: () => '',
      queryDefault: async (scheme) => (scheme === 'obsidian' ? 'obsidian.desktop' : ''),
      readDesktop: async () => '[Desktop Entry]\nName=Obsidian\nExec=obsidian %u\n',
    },
    browser: {
      platform: 'linux',
      env: { PATH: '/opt/bin' },
      home: '/home/u',
      exists: (path) => installed.includes(path),
    },
    startBrowser,
  }
}

beforeEach(() => {
  openExternal.mockClear()
  startBrowser.mockClear()
  terminal = undefined
  installed = []
})

describe('appLinkInfo', () => {
  it('names the app that handles a scheme', async () => {
    expect(await appLinkInfo(deps(), fromApp, 'obsidian://open?vault=a')).toEqual({
      ok: true,
      app: 'Obsidian',
    })
  })

  it('names the installed browser for a browser page', async () => {
    installed = ['/opt/bin/google-chrome-stable']
    expect(await appLinkInfo(deps(), fromApp, 'chrome://inspect/#remote-debugging')).toEqual({
      ok: true,
      app: 'Google Chrome',
    })
  })

  it('answers no-handler when no app or browser is there', async () => {
    expect(await appLinkInfo(deps(), fromApp, 'slack://channel?id=1')).toEqual({
      ok: false,
      error: 'no-handler',
    })
    expect(await appLinkInfo(deps(), fromApp, 'edge://settings')).toEqual({
      ok: false,
      error: 'no-handler',
    })
  })

  it('refuses a web link and a blocked scheme', async () => {
    for (const raw of ['https://example.com', 'mailto:a@b.c', 'chrome-extension://x/a', 1]) {
      expect(await appLinkInfo(deps(), fromApp, raw)).toEqual({ ok: false, error: 'blocked' })
    }
  })
})

describe('openLink', () => {
  it('does not open an app until the question is answered', async () => {
    expect(await openLink(deps(), fromApp, 'obsidian://open?vault=a', false)).toEqual({
      ok: false,
      error: 'not-allowed',
    })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens an app after a confirmed answer, with spaces and Chinese encoded', async () => {
    const raw = 'obsidian://advanced-uri?vault=Nexus One&filepath=中.md'
    expect(await openLink(deps(), fromApp, raw, true)).toEqual({ ok: true })
    expect(openExternal.mock.calls).toEqual([
      ['obsidian://advanced-uri?vault=Nexus%20One&filepath=%E4%B8%AD.md'],
    ])
  })

  it('treats a confirmation that is not exactly true as no confirmation', async () => {
    expect(await openLink(deps(), fromApp, 'obsidian://open', 'yes')).toEqual({
      ok: false,
      error: 'not-allowed',
    })
  })

  it('opens an allowed scheme and everything when the question is off', async () => {
    terminal = { allowedAppSchemes: ['obsidian'] }
    expect(await openLink(deps(), fromApp, 'obsidian://open', false)).toEqual({ ok: true })
    terminal = { askBeforeOpeningApps: false }
    expect(await openLink(deps(), fromApp, 'obsidian://open', false)).toEqual({ ok: true })
    expect(openExternal).toHaveBeenCalledTimes(2)
  })

  it('keeps asking for another scheme than the allowed ones', async () => {
    terminal = { allowedAppSchemes: ['vscode'] }
    expect(await openLink(deps(), fromApp, 'obsidian://open', false)).toEqual({
      ok: false,
      error: 'not-allowed',
    })
  })

  it('starts the installed browser for a browser page with the address as one argument', async () => {
    installed = ['/opt/bin/google-chrome-stable']
    expect(await openLink(deps(), fromApp, 'chrome://inspect/#remote-debugging', true)).toEqual({
      ok: true,
    })
    expect(startBrowser).toHaveBeenCalledWith(
      {
        app: 'Google Chrome',
        command: '/opt/bin/google-chrome-stable',
        args: ['chrome://inspect/#remote-debugging'],
      },
      { PATH: '/opt/bin' },
    )
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('starts nothing for a browser page when the browser is not installed', async () => {
    expect(await openLink(deps(), fromApp, 'brave://settings', true)).toEqual({
      ok: false,
      error: 'no-handler',
    })
    expect(startBrowser).not.toHaveBeenCalled()
  })

  it('opens a web or mail link without a question', async () => {
    expect(await openLink(deps(), fromApp, 'https://example.com/a b', false)).toEqual({ ok: true })
    expect(await openLink(deps(), fromApp, 'mailto:a@b.c', false)).toEqual({ ok: true })
    expect(openExternal).toHaveBeenCalledTimes(2)
  })

  it('never opens scripts, files, internal schemes or links with a password, even confirmed', async () => {
    terminal = { askBeforeOpeningApps: false }
    for (const raw of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,x',
      'devtools://devtools/a',
      'chrome-extension://x/a',
      'view-source://a',
      'ostia://settings-schema',
      'remote://folder/a',
      'smb://host/share',
      'search-ms://query=a',
      'ms-msdt://id',
      'x-app:do',
      'postgres://u:p@h/db',
      1,
    ]) {
      expect(await openLink(deps(), fromApp, raw, true)).toEqual({ ok: false, error: 'blocked' })
    }
    expect(openExternal).not.toHaveBeenCalled()
    expect(startBrowser).not.toHaveBeenCalled()
  })

  it('refuses a request from a subframe or a window that is not an app window', async () => {
    const fromFrame = { sender: appSender, senderFrame: {} } as unknown as Event
    const other = { mainFrame }
    owners.set(other, {})
    const fromOther = { sender: other, senderFrame: mainFrame } as unknown as Event
    for (const e of [fromFrame, fromOther]) {
      expect(await openLink(deps(), e, 'obsidian://open', true)).toEqual({
        ok: false,
        error: 'blocked',
      })
    }
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('reports a failure when the system cannot open the link', async () => {
    openExternal.mockRejectedValueOnce(new Error('no handler'))
    expect(await openLink(deps(), fromApp, 'obsidian://open', true)).toEqual({
      ok: false,
      error: 'failed',
    })
  })
})
