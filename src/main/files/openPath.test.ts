import { describe, expect, it, vi } from 'vitest'

const openExternal = vi.fn(async (_url: string) => {})
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: { openExternal } }))

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
  const fromApp = { sender: { mainFrame }, senderFrame: mainFrame } as unknown as Parameters<
    typeof openLink
  >[0]

  it('opens obsidian and vscode links with spaces and Chinese encoded', async () => {
    openExternal.mockClear()
    const vault =
      'obsidian://advanced-uri?vault=Interdisciplinary Nexus&filepath=05 Projects/中文.md'
    expect(await openLink(fromApp, vault)).toBe(true)
    expect(await openLink(fromApp, 'vscode://file/My Dir/a.ts:3')).toBe(true)
    expect(openExternal.mock.calls.map(([url]) => url)).toEqual([
      'obsidian://advanced-uri?vault=Interdisciplinary%20Nexus&filepath=05%20Projects/%E4%B8%AD%E6%96%87.md',
      'vscode://file/My%20Dir/a.ts:3',
    ])
  })

  it('refuses scripts, files, data, unknown schemes and non-strings', async () => {
    openExternal.mockClear()
    for (const raw of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,x',
      'x-app://do',
      1,
    ]) {
      expect(await openLink(fromApp, raw)).toBe(false)
    }
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('refuses a request from a subframe', async () => {
    openExternal.mockClear()
    const fromFrame = { sender: { mainFrame }, senderFrame: {} } as unknown as typeof fromApp
    expect(await openLink(fromFrame, 'obsidian://open?vault=a')).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('reports a failure when no app handles the link', async () => {
    openExternal.mockRejectedValueOnce(new Error('no handler'))
    expect(await openLink(fromApp, 'vscode://file/a')).toBe(false)
  })
})
