import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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

const printed: Record<
  string,
  { text: string; cwd: string | null; remote: boolean; sandboxed: boolean } | null
> = {}

function print(
  paneId: string,
  text: string,
  cwd: string | null = null,
  remote = false,
  sandboxed = false,
): void {
  printed[paneId] = { text, cwd, remote, sandboxed }
}

function setup(workspace: { sandboxed?: boolean; scratch?: boolean } = {}) {
  const grants = new OpenFileGrants({ roots: () => [home], file: join(base, 'opened-files.json') })
  const openPath = vi.fn(async (_path: string) => '')
  const showInFolder = vi.fn()
  const links = new TerminalPathLinks({
    grants,
    home,
    hostname: 'Justins-Mac.local',
    output: async (paneId) => printed[paneId] ?? null,
    pane: (paneId) =>
      paneId === 'p1' || paneId === 'p2' ? { windowId: '7', workspaceId: 'w1' } : undefined,
    isSandboxed: () => workspace.sandboxed ?? false,
    isScratch: () => workspace.scratch ?? false,
    openPath,
    showInFolder,
  })
  return { grants, links, openPath, showInFolder }
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

describe('TerminalPathLinks.openDefault', () => {
  it('opens a printed file or folder with the system default by its real path', async () => {
    const { links, openPath } = setup()
    expect(await links.openDefault(WINDOW, 'p1', join(outside, 'link.png'))).toEqual({ ok: true })
    expect(openPath).toHaveBeenCalledWith(join(outside, 'shots', 'a.png'))
    expect(await links.openDefault(WINDOW, 'p1', join(outside, 'shots-link'))).toEqual({ ok: true })
    expect(openPath).toHaveBeenLastCalledWith(join(outside, 'shots'))
    openPath.mockClear()

    for (const path of ['/dev/null', join(outside, 'null-link'), join(outside, 'gone')]) {
      expect(await links.openDefault(WINDOW, 'p1', path)).toEqual({ ok: false, error: 'not-found' })
    }
    expect(openPath).not.toHaveBeenCalled()
  })

  it('refuses a program, script or launcher instead of launching it', async () => {
    const { links, openPath } = setup()
    writeFileSync(join(outside, 'build.sh'), 'echo hi')
    writeFileSync(join(outside, 'tool'), 'bin', { mode: 0o755 })
    writeFileSync(join(outside, 'setup.ps1'), 'Write-Host hi')
    writeFileSync(join(outside, 'site.fileloc'), '<plist/>')
    writeFileSync(join(outside, 'payload'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))
    writeFileSync(join(outside, 'notes.txt'), '#!/bin/sh\nrm -rf ~\n')
    writeFileSync(join(outside, 'win.dat'), Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0]))
    writeFileSync(join(outside, 'mac.bin'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0]))
    writeFileSync(
      join(outside, 'launcher.txt'),
      '# made by a tool\n\n[Desktop Entry]\nType=Application\nExec=sh\n',
    )
    symlinkSync(join(outside, 'tool'), join(outside, 'tool-link.pdf'))
    const names = [
      'build.sh',
      'tool',
      'Tool.app',
      'setup.ps1',
      'site.fileloc',
      'payload',
      'notes.txt',
      'win.dat',
      'mac.bin',
      'launcher.txt',
      'tool-link.pdf',
    ]
    print('p1', names.map((name) => join(outside, name)).join(' '))
    for (const name of names) {
      expect(await links.openDefault(WINDOW, 'p1', join(outside, name))).toEqual({
        ok: false,
        error: 'program',
      })
    }
    expect(openPath).not.toHaveBeenCalled()
  })

  it('opens a document whose text only mentions a launcher or a shebang', async () => {
    const { links, openPath } = setup()
    const note = join(outside, 'howto.md')
    writeFileSync(note, 'Start a script with #!/bin/sh and a [Desktop Entry] header.\n')
    print('p1', `wrote ${note}`)
    expect(await links.openDefault(WINDOW, 'p1', note)).toEqual({ ok: true })
    expect(openPath).toHaveBeenCalledWith(note)
  })

  it('answers failed when the system has no app for the file', async () => {
    const { links, openPath } = setup()
    openPath.mockResolvedValueOnce('no application')
    expect(await links.openDefault(WINDOW, 'p1', join(outside, 'shots', 'a.png'))).toEqual({
      ok: false,
      error: 'failed',
    })
  })

  it('opens nothing for a sandboxed or scratch workspace, another window or a guest', async () => {
    const file = join(outside, 'shots', 'a.png')
    const refused = { ok: false, error: 'not-found' }
    for (const workspace of [{ sandboxed: true }, { scratch: true }]) {
      const { links, openPath } = setup(workspace)
      expect(await links.openDefault(WINDOW, 'p1', file)).toEqual(refused)
      expect(openPath).not.toHaveBeenCalled()
    }
    const { links, openPath } = setup()
    expect(await links.openDefault(OTHER_WINDOW, 'p1', file)).toEqual(refused)
    expect(await links.openDefault(WEBVIEW, 'p1', file)).toEqual(refused)
    expect(await links.openDefault(WINDOW, 'p9', file)).toEqual(refused)
    expect(openPath).not.toHaveBeenCalled()
  })
})

describe('TerminalPathLinks in a pane still sandboxed', () => {
  it('opens, shows and grants nothing while the pane itself runs sandboxed', async () => {
    const { links, grants, openPath, showInFolder } = setup()
    const file = join(outside, 'shots', 'a.png')
    print('p1', `saved ${file}`, null, false, true)
    const refused = { ok: false, error: 'not-found' }
    expect(await links.probe(WINDOW, 'p1', file)).toBeNull()
    expect(await links.admit(WINDOW, 'p1', file)).toBeNull()
    expect(await links.openDefault(WINDOW, 'p1', file)).toEqual(refused)
    expect(await links.showInFolder(WINDOW, 'p1', file)).toEqual(refused)
    expect(grants.confine(file)).toBeNull()
    expect(openPath).not.toHaveBeenCalled()
    expect(showInFolder).not.toHaveBeenCalled()
  })
})

describe('TerminalPathLinks.showInFolder', () => {
  it('shows a printed file or folder in its folder by its real path, a program included', async () => {
    const { links, showInFolder, openPath } = setup()
    expect(await links.showInFolder(WINDOW, 'p1', join(outside, 'link.png'))).toEqual({ ok: true })
    expect(showInFolder).toHaveBeenCalledWith(join(outside, 'shots', 'a.png'))
    expect(await links.showInFolder(WINDOW, 'p1', join(outside, 'Tool.app'))).toEqual({ ok: true })
    expect(showInFolder).toHaveBeenLastCalledWith(join(outside, 'Tool.app'))
    expect(openPath).not.toHaveBeenCalled()
  })

  it('shows nothing the pane never printed, nor what only another pane printed', async () => {
    const { links, showInFolder } = setup()
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'x')
    const refused = { ok: false, error: 'not-found' }
    expect(await links.showInFolder(WINDOW, 'p1', secret)).toEqual(refused)
    print('p2', `made ${secret}`)
    expect(await links.showInFolder(WINDOW, 'p1', secret)).toEqual(refused)
    expect(showInFolder).not.toHaveBeenCalled()
  })

  it('shows nothing that is gone or not a file or folder', async () => {
    const { links, showInFolder } = setup()
    for (const path of ['/dev/null', join(outside, 'gone')]) {
      expect(await links.showInFolder(WINDOW, 'p1', path)).toEqual({
        ok: false,
        error: 'not-found',
      })
    }
    expect(showInFolder).not.toHaveBeenCalled()
  })

  it('shows nothing for a sandboxed or scratch workspace, another window or a guest', async () => {
    const file = join(outside, 'shots', 'a.png')
    const refused = { ok: false, error: 'not-found' }
    for (const workspace of [{ sandboxed: true }, { scratch: true }]) {
      const { links, showInFolder } = setup(workspace)
      expect(await links.showInFolder(WINDOW, 'p1', file)).toEqual(refused)
      expect(showInFolder).not.toHaveBeenCalled()
    }
    const { links, showInFolder } = setup()
    expect(await links.showInFolder(OTHER_WINDOW, 'p1', file)).toEqual(refused)
    expect(await links.showInFolder(WEBVIEW, 'p1', file)).toEqual(refused)
    expect(showInFolder).not.toHaveBeenCalled()
  })
})

describe('a path is acted on only when its own pane printed it', () => {
  it('refuses a file or folder the pane never printed, and one only another pane printed', async () => {
    const { links, grants, openPath } = setup()
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'x')
    mkdirSync(join(outside, 'private'))
    expect(await links.admit(WINDOW, 'p1', secret)).toBeNull()
    expect(await links.openDefault(WINDOW, 'p1', join(outside, 'private'))).toEqual({
      ok: false,
      error: 'not-found',
    })

    print('p2', `made ${secret} in ${join(outside, 'private')}`)
    expect(await links.admit(WINDOW, 'p1', secret)).toBeNull()
    expect(await links.openDefault(WINDOW, 'p1', join(outside, 'private'))).toEqual({
      ok: false,
      error: 'not-found',
    })
    expect(grants.confine(secret)).toBeNull()
    expect(openPath).not.toHaveBeenCalled()

    expect(await links.admit(WINDOW, 'p2', secret)).toEqual({ ok: true, path: secret })
    expect(await links.openDefault(WINDOW, 'p2', join(outside, 'private'))).toEqual({ ok: true })
    expect(openPath).toHaveBeenCalledWith(join(outside, 'private'))
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
    const { links, grants, openPath, showInFolder } = setup()
    const file = join(outside, 'shots', 'a.png')
    const folder = join(outside, 'shots')
    const refused = { ok: false, error: 'not-found' }
    print('p1', `saved ${file} in ${folder}`, null, true)
    expect(await links.probe(WINDOW, 'p1', file)).toBeNull()
    expect(await links.admit(WINDOW, 'p1', file)).toBeNull()
    expect(await links.openDefault(WINDOW, 'p1', folder)).toEqual(refused)
    expect(await links.openDefault(WINDOW, 'p1', file)).toEqual(refused)
    expect(await links.showInFolder(WINDOW, 'p1', file)).toEqual(refused)
    expect(grants.confine(file)).toBeNull()
    expect(openPath).not.toHaveBeenCalled()
    expect(showInFolder).not.toHaveBeenCalled()
  })

  it('refuses a path that is only part of what the pane printed', async () => {
    const { links } = setup()
    print('p1', `wrote ${join(outside, 'shots', 'a.png')}.bak`)
    expect(await links.admit(WINDOW, 'p1', join(outside, 'shots', 'a.png'))).toBeNull()
    expect(await links.admit(WINDOW, 'p1', join(outside, 'shots'))).toBeNull()
  })

  it('resolves a relative path in the folder the pane itself reported, and ~ in the real home', async () => {
    const { links, openPath } = setup()
    mkdirSync(join(home, 'docs'))
    print('p1', 'see shots/a.png and ~/docs', outside)
    expect(await links.admit(WINDOW, 'p1', 'shots/a.png')).toEqual({
      ok: true,
      path: join(outside, 'shots', 'a.png'),
    })
    expect(await links.openDefault(WINDOW, 'p1', '~/docs')).toEqual({ ok: true })
    expect(openPath).toHaveBeenCalledWith(join(home, 'docs'))
  })

  it('refuses a relative path while the pane reported no folder, and everything for a pane with no output', async () => {
    const { links } = setup()
    print('p1', 'see shots/a.png')
    expect(await links.admit(WINDOW, 'p1', 'shots/a.png')).toBeNull()
    printed.p1 = null
    expect(await links.admit(WINDOW, 'p1', join(outside, 'shots', 'a.png'))).toBeNull()
  })
})

describe('TerminalPathLinks file URLs', () => {
  const url = (path: string): string => pathToFileURL(path).href

  function homeFiles() {
    const docs = join(home, 'docs')
    mkdirSync(docs)
    const files = {
      page: join(docs, 'speakers.html'),
      pdf: join(docs, 'report.pdf'),
      png: join(docs, 'shot.png'),
      spaced: join(docs, '會議 記錄.PDF'),
      command: join(docs, 'run.command'),
      script: join(docs, 'build.sh'),
      tool: join(docs, 'Tool.app'),
      bare: join(docs, 'tool'),
      runnable: join(docs, 'notes.txt'),
      shebang: join(docs, 'start.md'),
      toOutside: join(docs, 'outside.png'),
      toScript: join(docs, 'build.json'),
      toPdf: join(docs, 'alias.pdf'),
    }
    for (const file of [files.page, files.pdf, files.png, files.spaced, files.command]) {
      writeFileSync(file, 'x')
    }
    writeFileSync(files.script, 'echo hi')
    writeFileSync(files.shebang, '#!/bin/sh\necho hi')
    mkdirSync(files.tool)
    writeFileSync(files.bare, 'x')
    chmodSync(files.bare, 0o755)
    writeFileSync(files.runnable, 'x')
    chmodSync(files.runnable, 0o744)
    symlinkSync(join(outside, 'shots', 'a.png'), files.toOutside)
    symlinkSync(files.script, files.toScript)
    symlinkSync(files.pdf, files.toPdf)
    return { docs, ...files }
  }

  it('opens an html page and allowlisted files under home by their real path', async () => {
    const { links, openPath } = setup()
    const f = homeFiles()
    expect(await links.fileUrl(WINDOW, 'p1', url(f.page))).toEqual({
      path: f.page,
      opener: 'html-page',
    })
    for (const file of [f.pdf, f.png]) {
      expect(await links.fileUrl(WINDOW, 'p1', url(file))).toEqual({
        path: file,
        opener: 'default-app',
      })
      expect(await links.openFileUrl(WINDOW, 'p1', url(file))).toEqual({ ok: true })
      expect(openPath).toHaveBeenLastCalledWith(file)
    }
    expect(await links.openFileUrl(WINDOW, 'p1', url(f.page))).toEqual({ ok: true })
    expect(openPath).toHaveBeenLastCalledWith(f.page)
  })

  it('decodes spaces and CJK, matches extensions in any case and accepts localhost', async () => {
    const { links } = setup()
    const f = homeFiles()
    const encoded = url(f.spaced)
    expect(encoded).toContain('%20')
    expect(await links.fileUrl(WINDOW, 'p1', encoded)).toEqual({
      path: f.spaced,
      opener: 'default-app',
    })
    expect(await links.fileUrl(WINDOW, 'p1', `file://localhost${f.pdf}`)).toMatchObject({
      path: f.pdf,
    })
    expect(await links.fileUrl(WINDOW, 'p1', url(f.toPdf))).toEqual({
      path: f.pdf,
      opener: 'default-app',
    })
  })

  it('keeps commands, apps, scripts, executables, folders and missing files inert', async () => {
    const { links, openPath } = setup()
    const f = homeFiles()
    for (const target of [
      f.command,
      f.script,
      f.tool,
      f.bare,
      f.runnable,
      f.docs,
      `${f.docs}/`,
      join(f.docs, 'gone.pdf'),
    ]) {
      expect(await links.fileUrl(WINDOW, 'p1', url(target))).toBeNull()
      expect(await links.openFileUrl(WINDOW, 'p1', url(target))).toEqual({
        ok: false,
        error: 'not-found',
      })
    }
    expect(openPath).not.toHaveBeenCalled()
  })

  it('refuses files outside home, also through a symlink or .. and a symlink to a script', async () => {
    const { links, openPath } = setup()
    const f = homeFiles()
    for (const raw of [
      'file:///etc/hosts',
      url(join(outside, 'shots', 'a.png')),
      url(f.toOutside),
      url(f.toScript),
      `${url(home)}/../outside/shots/a.png`,
      `${url(home)}/docs/..%2F..%2Foutside/shots/a.png`,
    ]) {
      expect(await links.fileUrl(WINDOW, 'p1', raw)).toBeNull()
      expect(await links.openFileUrl(WINDOW, 'p1', raw)).toEqual({ ok: false, error: 'not-found' })
    }
    expect(openPath).not.toHaveBeenCalled()
  })

  it('accepts the local hostname that ls, rg, fd and eza put in their hyperlinks', async () => {
    const { links, openPath } = setup()
    const f = homeFiles()
    for (const host of ['Justins-Mac', 'justins-mac.local', 'JUSTINS-MAC.LOCAL']) {
      expect(await links.fileUrl(WINDOW, 'p1', `file://${host}${f.pdf}`)).toEqual({
        path: f.pdf,
        opener: 'default-app',
      })
    }
    expect(await links.openFileUrl(WINDOW, 'p1', `file://Justins-Mac${f.png}`)).toEqual({
      ok: true,
    })
    expect(openPath).toHaveBeenCalledWith(f.png)
  })

  it('refuses a hostname that only looks local', async () => {
    const { links, openPath } = setup()
    const f = homeFiles()
    for (const host of [
      'localhost.evil',
      'justins-mac.evil',
      'other-mac',
      'justins-mac.local.evil',
    ]) {
      expect(await links.fileUrl(WINDOW, 'p1', `file://${host}${f.pdf}`)).toBeNull()
      expect(await links.openFileUrl(WINDOW, 'p1', `file://${host}${f.pdf}`)).toEqual({
        ok: false,
        error: 'not-found',
      })
    }
    expect(openPath).not.toHaveBeenCalled()
  })

  it('refuses another host, other schemes and malformed urls', async () => {
    const { links } = setup()
    const f = homeFiles()
    for (const raw of [
      `file://server${f.pdf}`,
      f.pdf,
      `https://a.b${f.pdf}`,
      `${url(f.docs)}/%E0%A4%A.pdf`,
      `${url(f.pdf)}%00.pdf`,
      42,
    ]) {
      expect(await links.fileUrl(WINDOW, 'p1', raw)).toBeNull()
    }
  })

  it('still refuses a file that looks like a program when opening it', async () => {
    const { links, openPath } = setup()
    const f = homeFiles()
    expect(await links.fileUrl(WINDOW, 'p1', url(f.shebang))).toMatchObject({ path: f.shebang })
    expect(await links.openFileUrl(WINDOW, 'p1', url(f.shebang))).toEqual({
      ok: false,
      error: 'program',
    })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('answers nothing to a sandboxed, scratch, remote or foreign pane', async () => {
    const f = homeFiles()
    const target = url(f.pdf)
    expect(await setup({ sandboxed: true }).links.fileUrl(WINDOW, 'p1', target)).toBeNull()
    expect(await setup({ scratch: true }).links.fileUrl(WINDOW, 'p1', target)).toBeNull()
    const { links, openPath } = setup()
    expect(await links.fileUrl(OTHER_WINDOW, 'p1', target)).toBeNull()
    expect(await links.fileUrl(WEBVIEW, 'p1', target)).toBeNull()
    expect(await links.fileUrl(WINDOW, 'p9', target)).toBeNull()
    print('p1', 'remote', null, true)
    expect(await links.fileUrl(WINDOW, 'p1', target)).toBeNull()
    expect(await links.openFileUrl(WINDOW, 'p1', target)).toEqual({ ok: false, error: 'not-found' })
    print('p1', 'sandboxed', null, false, true)
    expect(await links.openFileUrl(WINDOW, 'p1', target)).toEqual({ ok: false, error: 'not-found' })
    expect(openPath).not.toHaveBeenCalled()
  })
})
