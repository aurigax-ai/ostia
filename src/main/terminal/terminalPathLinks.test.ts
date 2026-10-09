import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: {} }))

const { OpenFileGrants } = await import('../files/openFileGrants')
const { PROBE_RATE_MAX, TerminalPathLinks } = await import('./terminalPathLinks')

const WINDOW = { id: 7, getType: () => 'window' }
const WEBVIEW = { id: 7, getType: () => 'webview' }
const OTHER_WINDOW = { id: 8, getType: () => 'window' }

let now = 1_000

async function pass(ms: number): Promise<void> {
  now += ms
  await new Promise((resolve) => setTimeout(resolve, 5))
}

let base: string
let home: string
let outside: string

const printed: Record<string, { text: string; cwd: string | null; remote: boolean } | null> = {}

function print(paneId: string, text: string, cwd: string | null = null, remote = false): void {
  printed[paneId] = { text, cwd, remote }
}

function setup(workspace: { sandboxed?: boolean; scratch?: boolean } = {}) {
  const grants = new OpenFileGrants({ roots: () => [home], file: join(base, 'opened-files.json') })
  const openFolder = vi.fn(async () => '')
  const links = new TerminalPathLinks({
    grants,
    home,
    output: async (paneId) => printed[paneId] ?? null,
    pane: (paneId) =>
      paneId === 'p1' || paneId === 'p2' ? { windowId: '7', workspaceId: 'w1' } : undefined,
    isSandboxed: () => workspace.sandboxed ?? false,
    isScratch: () => workspace.scratch ?? false,
    openFolder,
  })
  return { grants, links, openFolder }
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-path-links-')))
  home = join(base, 'home')
  outside = join(base, 'outside')
  mkdirSync(home)
  mkdirSync(join(outside, 'shots'), { recursive: true })
  writeFileSync(join(outside, 'shots', 'a.png'), 'png')
  symlinkSync(join(outside, 'shots', 'a.png'), join(outside, 'link.png'))
  symlinkSync('/dev/null', join(outside, 'null-link'))
  symlinkSync(join(outside, 'shots'), join(outside, 'shots-link'))
  mkdirSync(join(outside, 'Tool.app'))
  for (const paneId of Object.keys(printed)) delete printed[paneId]
  print(
    'p1',
    [
      `saved ${join(outside, 'shots', 'a.png')}:3`,
      `see ${join(outside, 'link.png')} and ${join(outside, 'null-link')}`,
      `folders ${join(outside, 'shots')}/ ${join(outside, 'shots-link')} ${join(outside, 'Tool.app')}`,
      `gone ${join(outside, 'gone')} dev /dev/null`,
    ].join('\n'),
  )
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('TerminalPathLinks.probe', () => {
  it('answers only file, dir or null for an absolute path outside home', async () => {
    const { links } = setup()
    expect(await links.probe(WINDOW, 'p1', join(outside, 'shots', 'a.png'))).toBe('file')
    expect(await links.probe(WINDOW, 'p1', join(outside, 'shots'))).toBe('dir')
    expect(await links.probe(WINDOW, 'p1', join(outside, 'gone.txt'))).toBeNull()
    expect(await links.probe(WINDOW, 'p1', 'shots/a.png')).toBeNull()
    expect(await links.probe(WINDOW, 'p1', '~/a.png')).toBeNull()
    expect(await links.probe(WINDOW, 'p1', 42)).toBeNull()
  })

  it('follows a symlink to what it names and never calls a device a file', async () => {
    const { links } = setup()
    expect(await links.probe(WINDOW, 'p1', join(outside, 'link.png'))).toBe('file')
    expect(await links.probe(WINDOW, 'p1', '/dev/null')).toBeNull()
    expect(await links.probe(WINDOW, 'p1', join(outside, 'null-link'))).toBeNull()
  })

  it('answers nothing to a sandboxed or scratch workspace, another window, a guest or an unknown pane', async () => {
    const file = join(outside, 'shots', 'a.png')
    expect(await setup({ sandboxed: true }).links.probe(WINDOW, 'p1', file)).toBeNull()
    expect(await setup({ scratch: true }).links.probe(WINDOW, 'p1', file)).toBeNull()
    const { links } = setup()
    expect(await links.probe(OTHER_WINDOW, 'p1', file)).toBeNull()
    expect(await links.probe(WEBVIEW, 'p1', file)).toBeNull()
    expect(await links.probe(WINDOW, 'p9', file)).toBeNull()
    expect(await links.probe(WINDOW, 'p1', file)).toBe('file')
  })

  it('keeps an answer for five seconds', async () => {
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const { links } = setup()
      const late = join(outside, 'late.txt')
      print('p1', `soon ${late}`)
      expect(await links.probe(WINDOW, 'p1', late)).toBeNull()
      writeFileSync(late, 'x')
      await pass(4_900)
      expect(await links.probe(WINDOW, 'p1', late)).toBeNull()
      await pass(200)
      expect(await links.probe(WINDOW, 'p1', late)).toBe('file')
    } finally {
      clock.mockRestore()
    }
  })

  it('stops looking at the disk once a window asked about too many new paths in a second', async () => {
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const { links } = setup()
      const names = Array.from({ length: PROBE_RATE_MAX }, (_, i) => join(outside, `f${i}.txt`))
      for (const name of names) writeFileSync(name, 'x')
      print('p1', [...names, join(outside, 'shots', 'a.png')].join('\n'))
      for (let i = 0; i < PROBE_RATE_MAX; i++) {
        expect(await links.probe(WINDOW, 'p1', join(outside, `f${i}.txt`))).toBe('file')
      }
      const file = join(outside, 'shots', 'a.png')
      expect(await links.probe(WINDOW, 'p1', file)).toBeNull()
      expect(await links.probe(WINDOW, 'p1', join(outside, 'f0.txt'))).toBe('file')
      await pass(1_100)
      expect(await links.probe(WINDOW, 'p1', file)).toBe('file')
    } finally {
      clock.mockRestore()
    }
  })
})

describe('TerminalPathLinks.admit', () => {
  it('grants exactly the clicked file, by its real path', async () => {
    const { links, grants } = setup()
    const file = join(outside, 'shots', 'a.png')
    expect(grants.confine(file)).toBeNull()
    expect(await links.admit(WINDOW, 'p1', join(outside, 'link.png'))).toEqual({
      ok: true,
      path: file,
    })
    expect(grants.confine(file)).toBe(file)
    writeFileSync(join(outside, 'shots', 'b.png'), 'png')
    expect(grants.confine(join(outside, 'shots', 'b.png'))).toBeNull()
    expect(grants.confine(join(outside, 'shots'))).toBeNull()
  })

  it('never grants a folder, a device or a symlink to one', async () => {
    const { links, grants } = setup()
    expect(await links.admit(WINDOW, 'p1', join(outside, 'shots'))).toMatchObject({
      ok: false,
      error: 'directory',
    })
    expect(await links.admit(WINDOW, 'p1', '/dev/null')).toMatchObject({
      ok: false,
      error: 'not-a-file',
    })
    expect(await links.admit(WINDOW, 'p1', join(outside, 'null-link'))).toMatchObject({
      ok: false,
      error: 'not-a-file',
    })
    expect(grants.confine(join(outside, 'shots'))).toBeNull()
    expect(grants.confine('/dev/null')).toBeNull()
  })

  it('grants nothing to a sandboxed or scratch workspace, another window or a guest', async () => {
    const file = join(outside, 'shots', 'a.png')
    for (const workspace of [{ sandboxed: true }, { scratch: true }]) {
      const { links, grants } = setup(workspace)
      expect(await links.admit(WINDOW, 'p1', file)).toBeNull()
      expect(grants.confine(file)).toBeNull()
    }
    const { links, grants } = setup()
    expect(await links.admit(OTHER_WINDOW, 'p1', file)).toBeNull()
    expect(await links.admit(WEBVIEW, 'p1', file)).toBeNull()
    expect(await links.admit(WINDOW, 'p9', file)).toBeNull()
    expect(grants.confine(file)).toBeNull()
  })
})

describe('TerminalPathLinks.openFolder', () => {
  it('opens a folder by its real path and nothing that is not a folder', async () => {
    const { links, openFolder } = setup()
    expect(await links.openFolder(WINDOW, 'p1', join(outside, 'shots-link'))).toEqual({ ok: true })
    expect(openFolder).toHaveBeenCalledWith(join(outside, 'shots'))
    openFolder.mockClear()

    for (const path of [join(outside, 'shots', 'a.png'), '/dev/null', join(outside, 'gone')]) {
      expect(await links.openFolder(WINDOW, 'p1', path)).toEqual({ ok: false, error: 'not-found' })
    }
    expect(openFolder).not.toHaveBeenCalled()
  })

  it('refuses a folder the system would launch as a program', async () => {
    const { links, openFolder } = setup()
    expect(await links.openFolder(WINDOW, 'p1', join(outside, 'Tool.app'))).toEqual({
      ok: false,
      error: 'program',
    })
    expect(openFolder).not.toHaveBeenCalled()
  })

  it('opens nothing for a sandboxed or scratch workspace, another window or a guest', async () => {
    const folder = join(outside, 'shots')
    const refused = { ok: false, error: 'not-found' }
    for (const workspace of [{ sandboxed: true }, { scratch: true }]) {
      const { links, openFolder } = setup(workspace)
      expect(await links.openFolder(WINDOW, 'p1', folder)).toEqual(refused)
      expect(openFolder).not.toHaveBeenCalled()
    }
    const { links, openFolder } = setup()
    expect(await links.openFolder(OTHER_WINDOW, 'p1', folder)).toEqual(refused)
    expect(await links.openFolder(WEBVIEW, 'p1', folder)).toEqual(refused)
    expect(openFolder).not.toHaveBeenCalled()
  })
})

describe('a path is acted on only when its own pane printed it', () => {
  it('refuses a file or folder the pane never printed, and one only another pane printed', async () => {
    const { links, grants, openFolder } = setup()
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'x')
    mkdirSync(join(outside, 'private'))
    expect(await links.admit(WINDOW, 'p1', secret)).toBeNull()
    expect(await links.openFolder(WINDOW, 'p1', join(outside, 'private'))).toEqual({
      ok: false,
      error: 'not-found',
    })

    print('p2', `made ${secret} in ${join(outside, 'private')}`)
    expect(await links.admit(WINDOW, 'p1', secret)).toBeNull()
    expect(await links.openFolder(WINDOW, 'p1', join(outside, 'private'))).toEqual({
      ok: false,
      error: 'not-found',
    })
    expect(grants.confine(secret)).toBeNull()
    expect(openFolder).not.toHaveBeenCalled()

    expect(await links.admit(WINDOW, 'p2', secret)).toEqual({ ok: true, path: secret })
    expect(await links.openFolder(WINDOW, 'p2', join(outside, 'private'))).toEqual({ ok: true })
    expect(openFolder).toHaveBeenCalledWith(join(outside, 'private'))
  })

  it('tells nothing about a path the pane never printed, and resolves a printed relative one in the pane’s own folder', async () => {
    const { links } = setup()
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'x')
    expect(await links.probe(WINDOW, 'p1', secret)).toBeNull()
    print('p2', `made ${secret}`)
    expect(await links.probe(WINDOW, 'p1', secret)).toBeNull()
    expect(await links.probe(WINDOW, 'p2', secret)).toBe('file')

    print('p1', 'wrote shots/a.png', outside)
    expect(await links.probe(WINDOW, 'p1', 'shots/a.png')).toBe('file')
    print('p1', 'wrote shots/a.png', home)
    expect(await links.probe(WINDOW, 'p1', 'shots/a.png')).toBeNull()
  })

  it('does nothing for a pane whose shell reports another host', async () => {
    const { links, grants, openFolder } = setup()
    const file = join(outside, 'shots', 'a.png')
    const folder = join(outside, 'shots')
    print('p1', `saved ${file} in ${folder}`, null, true)
    expect(await links.probe(WINDOW, 'p1', file)).toBeNull()
    expect(await links.admit(WINDOW, 'p1', file)).toBeNull()
    expect(await links.openFolder(WINDOW, 'p1', folder)).toEqual({ ok: false, error: 'not-found' })
    expect(grants.confine(file)).toBeNull()
    expect(openFolder).not.toHaveBeenCalled()
  })

  it('refuses a path that is only part of what the pane printed', async () => {
    const { links } = setup()
    print('p1', `wrote ${join(outside, 'shots', 'a.png')}.bak`)
    expect(await links.admit(WINDOW, 'p1', join(outside, 'shots', 'a.png'))).toBeNull()
    expect(await links.admit(WINDOW, 'p1', join(outside, 'shots'))).toBeNull()
  })

  it('resolves a relative path in the folder the pane itself reported, and ~ in the real home', async () => {
    const { links, openFolder } = setup()
    mkdirSync(join(home, 'docs'))
    print('p1', 'see shots/a.png and ~/docs', outside)
    expect(await links.admit(WINDOW, 'p1', 'shots/a.png')).toEqual({
      ok: true,
      path: join(outside, 'shots', 'a.png'),
    })
    expect(await links.openFolder(WINDOW, 'p1', '~/docs')).toEqual({ ok: true })
    expect(openFolder).toHaveBeenCalledWith(join(home, 'docs'))
  })

  it('refuses a relative path while the pane reported no folder, and everything for a pane with no output', async () => {
    const { links } = setup()
    print('p1', 'see shots/a.png')
    expect(await links.admit(WINDOW, 'p1', 'shots/a.png')).toBeNull()
    printed.p1 = null
    expect(await links.admit(WINDOW, 'p1', join(outside, 'shots', 'a.png'))).toBeNull()
  })
})
