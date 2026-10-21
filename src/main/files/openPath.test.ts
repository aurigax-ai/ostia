import { chmodSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openExternal = vi.fn(async (_url: string) => {})
const owners = vi.hoisted(() => new Map<unknown, unknown>())
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal },
  BrowserWindow: { fromWebContents: (wc: unknown) => owners.get(wc) ?? null },
}))

const { canOpenDefault, isProgram, openLink, openUnlessProgram } = await import('./openPath')

describe('isProgram', () => {
  it('treats launchers, scripts and executable files as programs', () => {
    expect(isProgram('/h/app.desktop', 0o644, true)).toBe(true)
    expect(isProgram('/h/run.sh', 0o644, true)).toBe(true)
    expect(isProgram('/h/tool', 0o755, true)).toBe(true)
    expect(isProgram('/h/Setup.EXE', 0o644, true)).toBe(true)
  })

  it('treats Windows and macOS launchers as programs, since there the extension is the only guard', () => {
    for (const name of ['a.ps1', 'a.VBS', 'a.hta', 'a.lnk', 'a.url', 'a.reg', 'a.pyw']) {
      expect(isProgram(`/h/${name}`, 0o644, true)).toBe(true)
    }
    for (const name of ['a.fileloc', 'a.webloc', 'a.terminal', 'a.tool', 'a.pkg', 'a.workflow']) {
      expect(isProgram(`/h/${name}`, 0o644, true)).toBe(true)
    }
  })

  it('lets documents and folders through', () => {
    expect(isProgram('/h/notes.md', 0o644, true)).toBe(false)
    expect(isProgram('/h/report.pdf', 0o600, true)).toBe(false)
    expect(isProgram('/h/folder', 0o755, false)).toBe(false)
  })
})

describe('openUnlessProgram', () => {
  let dir: string
  const openPath = vi.fn(async (_path: string) => '')
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-open-path-'))
    openPath.mockClear()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('opens a document and refuses one whose first bytes are a program, for the file menu too', async () => {
    const doc = join(dir, 'report.csv')
    writeFileSync(doc, 'a,b\n1,2\n')
    expect(await openUnlessProgram(doc, statSync(doc), openPath)).toEqual({ ok: true })
    const script = join(dir, 'report2.csv')
    writeFileSync(script, '#!/usr/bin/env python3\n')
    expect(await openUnlessProgram(script, statSync(script), openPath)).toEqual({
      ok: false,
      error: 'program',
    })
    expect(openPath).toHaveBeenCalledTimes(1)
  })

  it('reads a launcher header and a shebang after a BOM, and opens a doc that only mentions them', async () => {
    const write = (name: string, body: string | Buffer): string => {
      const path = join(dir, name)
      writeFileSync(path, body)
      return path
    }
    const refused = [
      write('a.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('#!/bin/sh\n')])),
      write('b.txt', '# tool\r\n\r\n  [Desktop Entry]\r\nExec=sh\r\n'),
    ]
    for (const path of refused) {
      expect(await openUnlessProgram(path, statSync(path), openPath)).toEqual({
        ok: false,
        error: 'program',
      })
    }
    const doc = write('c.md', 'Write a [Desktop Entry] header, or start with #! on line one.\n')
    expect(await openUnlessProgram(doc, statSync(doc), openPath)).toEqual({ ok: true })
    expect(openPath).toHaveBeenCalledTimes(1)
  })

  it('sniffs a hostile file of comment lines at once, without backtracking', async () => {
    const path = join(dir, 'notes.txt')
    writeFileSync(path, `#${'\r\n#'.repeat(100_000)}x`)
    const started = performance.now()
    expect(await openUnlessProgram(path, statSync(path), openPath)).toEqual({ ok: true })
    expect(performance.now() - started).toBeLessThan(1_000)
  }, 5_000)

  it('refuses a file replaced or made executable between the check and the open', async () => {
    const doc = join(dir, 'report.csv')
    writeFileSync(doc, 'a,b\n')
    const checked = statSync(doc)
    const swap = join(dir, 'swap.csv')
    writeFileSync(swap, 'c,d\n')
    renameSync(swap, doc)
    expect(await openUnlessProgram(doc, checked, openPath)).toEqual({
      ok: false,
      error: 'not-found',
    })

    const other = join(dir, 'other.csv')
    writeFileSync(other, 'e,f\n', { mode: 0o644 })
    const before = statSync(other)
    chmodSync(other, 0o600)
    expect(await openUnlessProgram(other, before, openPath)).toEqual({
      ok: false,
      error: 'not-found',
    })
    expect(openPath).not.toHaveBeenCalled()
  })
})

describe('canOpenDefault', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-can-open-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('agrees with openUnlessProgram and launches nothing', async () => {
    const doc = join(dir, 'model.blend')
    writeFileSync(doc, 'BLENDER')
    const script = join(dir, 'setup.exe')
    writeFileSync(script, 'MZ')
    const disguised = join(dir, 'notes.txt')
    writeFileSync(disguised, '#!/bin/sh\n')
    expect(await canOpenDefault(doc, statSync(doc))).toBe(true)
    expect(await canOpenDefault(script, statSync(script))).toBe(false)
    expect(await canOpenDefault(disguised, statSync(disguised))).toBe(false)
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
    expect(await open(fromApp, 'msteams://teams.microsoft.com/l/chat')).toBe(true)
    expect(openExternal.mock.calls.map(([url]) => url)).toEqual([
      'slack://channel?id=1',
      'zed://file/tmp/a',
      'msteams://teams.microsoft.com/l/chat',
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
      'smb://host/share',
      'search-ms://query=a',
      'ms-msdt://id',
      'postgres://u:p@h/db',
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
