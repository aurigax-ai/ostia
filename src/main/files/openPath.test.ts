import { describe, expect, it, vi } from 'vitest'

const openExternal = vi.fn(async (_url: string) => {})
const owners = vi.hoisted(() => new Map<unknown, unknown>())
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal },
  BrowserWindow: { fromWebContents: (wc: unknown) => owners.get(wc) ?? null },
}))

const { isProgram, openLink } = await import('./openPath')

describe('isProgram', () => {
  it('treats launchers, scripts and executable files as programs', () => {
    expect(isProgram('/h/app.desktop', 0o644, true)).toBe(true)
    expect(isProgram('/h/run.sh', 0o644, true)).toBe(true)
    expect(isProgram('/h/tool', 0o755, true)).toBe(true)
    expect(isProgram('/h/Setup.EXE', 0o644, true)).toBe(true)
  })

  it('lets documents and folders through', () => {
    expect(isProgram('/h/notes.md', 0o644, true)).toBe(false)
    expect(isProgram('/h/report.pdf', 0o600, true)).toBe(false)
    expect(isProgram('/h/folder', 0o755, false)).toBe(false)
  })
})

describe('openLink', () => {
  const mainFrame = {}
  const appSender = { mainFrame }
  const appWindow = {}
  owners.set(appSender, appWindow)
  const fromApp = { sender: appSender, senderFrame: mainFrame } as unknown as Parameters<
    typeof openLink
  >[1]
  const windows = () => [appWindow] as unknown as Iterable<Electron.BrowserWindow>
  const open = (e: typeof fromApp, raw: unknown) => openLink(windows, e, raw)

  it('opens obsidian and vscode links with spaces and Chinese encoded', async () => {
    openExternal.mockClear()
    const vault =
      'obsidian://advanced-uri?vault=Interdisciplinary Nexus&filepath=05 Projects/中文.md'
    expect(await open(fromApp, vault)).toBe(true)
    expect(await open(fromApp, 'vscode://file/My Dir/a.ts:3')).toBe(true)
    expect(openExternal.mock.calls.map(([url]) => url)).toEqual([
      'obsidian://advanced-uri?vault=Interdisciplinary%20Nexus&filepath=05%20Projects/%E4%B8%AD%E6%96%87.md',
      'vscode://file/My%20Dir/a.ts:3',
    ])
  })

  it('opens the raw, encoded and bare obsidian forms, each encoded once', async () => {
    openExternal.mockClear()
    const encoded =
      'obsidian://advanced-uri?vault=Interdisciplinary%20Nexus&filepath=05%20Projects/%E4%B8%AD.md'
    for (const raw of [
      'obsidian://advanced-uri?vault=Interdisciplinary Nexus&filepath=05 Projects/中.md',
      encoded,
    ]) {
      expect(await open(fromApp, raw)).toBe(true)
    }
    expect(openExternal.mock.calls.map(([url]) => url)).toEqual([encoded, encoded])
  })

  it('opens any other scheme with a double slash', async () => {
    openExternal.mockClear()
    expect(await open(fromApp, 'slack://channel?id=1')).toBe(true)
    expect(await open(fromApp, 'zed://file/tmp/a')).toBe(true)
    expect(openExternal.mock.calls.map(([url]) => url)).toEqual([
      'slack://channel?id=1',
      'zed://file/tmp/a',
    ])
  })

  it('refuses scripts, files, data, internal schemes and non-strings', async () => {
    openExternal.mockClear()
    for (const raw of [
      'javascript:alert(1)',
      'javascript://x%0Aalert(1)',
      'vbscript://x',
      'file:///etc/passwd',
      'data:text/html,x',
      'blob://x',
      'about://blank',
      'chrome://settings',
      'devtools://devtools/a',
      'view-source://a',
      'ostia://settings-schema',
      'ostia-preview://slot/index.html',
      'remote://folder/a',
      'x-app:do',
      'a://b',
      1,
    ]) {
      expect(await open(fromApp, raw)).toBe(false)
    }
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('refuses a request from a subframe', async () => {
    openExternal.mockClear()
    const fromFrame = { sender: appSender, senderFrame: {} } as unknown as typeof fromApp
    expect(await open(fromFrame, 'obsidian://open?vault=a')).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('refuses a request from a window that is not an app window', async () => {
    openExternal.mockClear()
    const otherSender = { mainFrame }
    owners.set(otherSender, {})
    const fromOther = { sender: otherSender, senderFrame: mainFrame } as unknown as typeof fromApp
    const fromNoWindow = {
      sender: { mainFrame },
      senderFrame: mainFrame,
    } as unknown as typeof fromApp
    expect(await open(fromOther, 'obsidian://open?vault=a')).toBe(false)
    expect(await open(fromNoWindow, 'obsidian://open?vault=a')).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('reports a failure when no app handles the link', async () => {
    openExternal.mockRejectedValueOnce(new Error('no handler'))
    expect(await open(fromApp, 'vscode://file/a')).toBe(false)
  })
})
