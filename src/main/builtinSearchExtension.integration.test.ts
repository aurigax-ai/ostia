import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ExtensionCaller,
  ExtensionOpenFileRequest,
  ExtensionResult,
} from '../shared/extensions'
import type { CommandResult } from '../shared/types'
import { registerControlServer, stopControlServer } from './controlServer'
import { ExtensionHost, registerExtensionMethods } from './extensionHost'
import { ExtensionStore } from './extensionStore'

const repoRoot = process.cwd()
const fakeRgBin = join(repoRoot, 'test', 'fixtures', 'search', 'bin')

interface RgCall {
  cwd: string
  argv: string[]
}

describe('built-in search extension', () => {
  let dir: string
  let work: string
  let rgLog: string
  let host: ExtensionHost
  const savedPath = process.env.PATH
  const openPanelIn = vi.fn()
  const openFileIn = vi.fn<(req: ExtensionOpenFileRequest) => Promise<ExtensionResult>>()

  const pane = (extra: Partial<ExtensionCaller> = {}): ExtensionCaller => ({
    kind: 'pane',
    workspaceId: 's1',
    cwd: work,
    capabilities: ['read-board'],
    ...extra,
  })
  const rgCalls = (): RgCall[] => {
    try {
      return readFileSync(rgLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RgCall)
    } catch {
      return []
    }
  }

  async function panelCall(command: string, args: unknown): Promise<ExtensionResult> {
    const panel = await host.resolvePanel('search', { workspaceId: 's1', locale: 'en' })
    if (!panel.ok) throw new Error(panel.error)
    const url = new URL(panel.src)
    const res = await fetch(new URL('/api', url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ostia-panel': url.searchParams.get('t') ?? '',
      },
      body: JSON.stringify({ command, args, context: { workspaceId: 's1', workDir: work } }),
    })
    return (await res.json()) as ExtensionResult
  }

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-search-ext-')))
    work = join(dir, 'work')
    mkdirSync(join(work, 'src'), { recursive: true })
    writeFileSync(join(work, 'src', 'main.ts'), 'a\nb\nconst hello = 1\n')
    rgLog = join(dir, 'rg.log')
    process.env.PATH = `${fakeRgBin}${delimiter}${savedPath ?? ''}`
    process.env.FAKE_RG_LOG = rgLog
    const socketPath = join(dir, 'control.sock')
    host = new ExtensionHost({
      roots: [{ dir: join(repoRoot, 'out', 'extensions'), builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      dataDir: join(dir, 'ext-data'),
      workDirForWorkspace: (sid) => (sid === 's1' ? work : undefined),
      broadcast: () => {},
      openPanelIn,
      openFileIn,
      notify: () => {},
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
      },
      socketPath,
    )
    host.startEager()
  })

  afterAll(() => {
    host.stopAll()
    stopControlServer()
    process.env.PATH = savedPath
    process.env.FAKE_RG_LOG = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    rmSync(rgLog, { force: true })
    openPanelIn.mockClear()
    openFileIn.mockReset()
  })

  it('finds text from the caller cwd and prints one grep-style line per match', async () => {
    const res = await host.invoke('search', 'find', { argv: ['hello'] }, pane())
    expect(res).toMatchObject({
      ok: true,
      text: 'src/main.ts:3:7: const hello = 1\n1 match in 1 file',
    })
    const [call] = rgCalls()
    expect(call.cwd).toBe(work)
    expect(call.argv.slice(-3)).toEqual(['--', 'hello', '.'])
    expect(call.argv).toContain('--fixed-strings')
  })

  it('answers --json with the folder and the matches by file', async () => {
    const res = await host.invoke('search', 'find', { argv: ['hello', '--json'] }, pane())
    expect(res).toMatchObject({
      ok: true,
      data: {
        root: work,
        matches: 1,
        truncated: false,
        files: [{ path: 'src/main.ts', matches: [{ line: 3, column: 7, ranges: [[6, 11]] }] }],
      },
    })
  })

  it('says there are no matches when rg finds none', async () => {
    const res = await host.invoke('search', 'find', { argv: ['absent'] }, pane())
    expect(res).toMatchObject({ ok: true, text: 'No matches' })
  })

  it('reports a broken regular expression as invalid-pattern', async () => {
    const res = await host.invoke('search', 'find', { argv: ['--regex', 'bad('] }, pane())
    expect(res).toMatchObject({ ok: false, error: 'invalid-pattern' })
    expect(res.ok ? '' : res.message).toContain('regex parse error')
  })

  it('refuses a sandboxed caller without running rg', async () => {
    const res = await host.invoke('search', 'find', { argv: ['hello'] }, pane({ sandboxed: true }))
    expect(res).toMatchObject({ ok: false, error: 'sandboxed' })
    expect(rgCalls()).toEqual([])
  })

  it('ranks file names for files', async () => {
    const res = await host.invoke('search', 'files', { argv: ['fv', '--json'] }, pane())
    expect(res).toMatchObject({ ok: true, data: { root: work, files: ['src/FileView.tsx'] } })
  })

  it('opens the panel from the palette, in files mode for Go to File', async () => {
    const user: ExtensionCaller = { kind: 'user', workspaceId: 's1', capabilities: ['read-board'] }
    expect(await host.invoke('search', 'files', null, user)).toMatchObject({ ok: true })
    expect(openPanelIn).toHaveBeenCalledWith({ extId: 'search', workspaceId: 's1', path: '/files' })
    expect(rgCalls()).toEqual([])
  })

  it('searches the workspace folder from the panel', async () => {
    const res = await panelCall('text', { text: 'hello', caseSensitive: true })
    expect(res).toMatchObject({ ok: true, data: { root: work, matches: 1 } })
    const [call] = rgCalls()
    expect(call.cwd).toBe(work)
    expect(call.argv).toContain('--case-sensitive')
  })

  it('opens a picked hit through ext.openFile at its line and column', async () => {
    openFileIn.mockResolvedValue({ ok: true })
    const res = await panelCall('open', { path: 'src/main.ts', line: 3, column: 7 })
    expect(res).toEqual({ ok: true })
    expect(openFileIn).toHaveBeenCalledWith({
      extId: 'search',
      workspaceId: 's1',
      path: join(work, 'src', 'main.ts'),
      line: 3,
      column: 7,
    })
  })

  it('never opens a path outside the workspace folder from the panel', async () => {
    const res = await panelCall('open', { path: '../../etc/passwd', line: 1 })
    expect(res).toMatchObject({ ok: false, error: 'invalid-args' })
    expect(openFileIn).not.toHaveBeenCalled()
  })
})
