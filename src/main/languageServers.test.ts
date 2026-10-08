import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type MessageConnection, createMessageConnection } from 'vscode-jsonrpc'
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node'
import type { LanguageServerContribution } from '../shared/languageServers'
import {
  type LanguageServerSource,
  LanguageServers,
  type LanguageServersDeps,
  type SpawnServer,
  confinedScript,
  findServerRoot,
  scrubbedEnv,
} from './languageServers'
import type { Requirement } from './systemRequirements'

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 4242
  signals: string[] = []
  exited = false
  received: { method: string; params: unknown }[] = []
  answersShutdown = true
  readonly peer: MessageConnection

  constructor() {
    super()
    this.peer = createMessageConnection(
      new StreamMessageReader(this.stdin),
      new StreamMessageWriter(this.stdout),
    )
    this.peer.onRequest('initialize', (params) => {
      this.received.push({ method: 'initialize', params })
      return { capabilities: {}, serverInfo: { name: 'fake', version: '9.9' } }
    })
    this.peer.onRequest('fail', () => {
      throw new Error('nope')
    })
    this.peer.onRequest('shutdown', () => {
      this.received.push({ method: 'shutdown', params: null })
      return this.answersShutdown ? null : new Promise(() => {})
    })
    this.peer.onNotification((method, params) => {
      this.received.push({ method, params })
      if (method === 'exit') this.exit(0, null)
    })
    this.peer.listen()
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code, signal)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    queueMicrotask(() => this.exit(null, signal))
    return true
  }
}

interface SpawnCall {
  command: string
  args: string[]
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: false }
  child: FakeChild
}

interface Harness {
  servers: LanguageServers
  sources: LanguageServerSource[]
  spawned: SpawnCall[]
  posts: { windowId: string; channel: string; args: unknown[] }[]
  requirements: Map<string, { requirements: Requirement[]; label?: string }>
  programs: Map<string, string>
  wrap: ReturnType<typeof vi.fn>
  sandboxed: Set<string>
  unreadable: Set<string>
  changed: ReturnType<typeof vi.fn>
  copies: Map<string, string>
  fetchBinary: ReturnType<typeof vi.fn>
  retained: Map<string, string>[]
  platformAsset: boolean
}

let tmp: string
let extensionDir: string
let workDir: string
const live: LanguageServers[] = []

const nodeServer: LanguageServerContribution = {
  id: 'fake',
  name: 'Fake',
  languages: ['plaintext'],
  documentLanguageIds: { plaintext: 'fake', '.special.txt': 'fake-special' },
  run: { node: 'server.js', args: ['--stdio', '--ext={extensionDir}', '--root={root}'] },
  rootMarkers: ['fake.toml'],
  initializationOptions: { home: '{extensionDir}', nested: { root: '{root}' } },
  settings: { fake: { mode: 'calm', root: '{root}' } },
  settingPaths: { mode: 'fake.mode' },
}

const programServer: LanguageServerContribution = {
  id: 'prog',
  name: 'Prog',
  languages: ['rust'],
  run: { program: 'prog-ls', package: 'prog-pkg', args: [] },
  rootMarkers: ['Cargo.toml'],
}

function source(
  server: LanguageServerContribution,
  extra: Partial<LanguageServerSource> = {},
): LanguageServerSource {
  return {
    extId: 'ext',
    extName: 'Ext',
    dir: extensionDir,
    builtin: true,
    state: 'on',
    server,
    settingValues: {},
    ...extra,
  }
}

function harness(overrides: Partial<LanguageServersDeps> = {}): Harness {
  const h = {
    sources: [source(nodeServer), source(programServer)],
    spawned: [],
    posts: [],
    requirements: new Map(),
    programs: new Map([['prog-ls', '/usr/bin/prog-ls']]),
    wrap: vi.fn(async (_workspaceId: string, command: string) => `wrapped ${command}`),
    sandboxed: new Set(),
    unreadable: new Set(),
    changed: vi.fn(),
    copies: new Map(),
    retained: [],
    platformAsset: true,
    fetchBinary: vi.fn(async (extId: string, serverId: string) => {
      const path = `/data/ls/${extId}/${serverId}/1.2.3/bin/tool`
      h.copies.set(`${extId}/${serverId}`, path)
      return path
    }),
  } as unknown as Harness
  const spawn: SpawnServer = (command, args, options) => {
    const child = new FakeChild()
    h.spawned.push({ command, args, options, child })
    return child as unknown as ReturnType<SpawnServer>
  }
  const servers = new LanguageServers({
    sources: () => h.sources,
    nodePath: '/opt/ostia/electron',
    env: () => ({ PATH: '/usr/bin', OSTIA_TOKEN: 'secret', OSTIA_SOCKET: '/s', HOME: '/home/u' }),
    pane: (paneId) =>
      paneId === 'p1'
        ? { windowId: 'w1', workspaceId: 'ws1' }
        : paneId === 'p2'
          ? { windowId: 'w2', workspaceId: 'ws2' }
          : undefined,
    confine: (path) => (path.startsWith(tmp) ? path : null),
    workDir: (workspaceId) => (workspaceId === 'ws1' ? workDir : undefined),
    roots: () => [tmp],
    sandbox: {
      owner: (workspaceId) => (h.sandboxed.has(workspaceId) ? workspaceId : null),
      readable: (_workspaceId, path) => !h.unreadable.has(path),
      wrap: h.wrap as unknown as LanguageServersDeps['sandbox']['wrap'],
      env: (_workspaceId, env) => ({ ...env, TMPDIR: '/sandbox-tmp' }),
    },
    findProgram: (program) => h.programs.get(program) ?? null,
    managed: {
      canFetch: (run) => 'goInstall' in run || ('download' in run && h.platformAsset),
      executable: (extId, serverId) => h.copies.get(`${extId}/${serverId}`) ?? null,
      folder: (extId, serverId, version) => `/data/ls/${extId}/${serverId}/${version}`,
      fetch: h.fetchBinary as unknown as LanguageServersDeps['managed']['fetch'],
      remove: (extId, serverId) => {
        h.copies.delete(`${extId}/${serverId}`)
      },
      retain: (keep) => {
        h.retained.push(new Map(keep))
      },
    },
    registerRequirements: (feature, requirements, label) => {
      if (requirements.length === 0) h.requirements.delete(feature)
      else h.requirements.set(feature, { requirements, label })
    },
    post: (windowId, channel, ...args) => h.posts.push({ windowId, channel, args }),
    changed: h.changed,
    spawn,
    idleMs: 20,
    restartDelayMs: 1,
    stopGraceMs: 30,
    ...overrides,
  })
  live.push(servers)
  h.servers = servers
  return h
}

async function initialize(h: Harness, sessionId: string): Promise<void> {
  h.servers.send('w1', sessionId, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  await vi.waitFor(() =>
    expect(h.posts.some((p) => p.channel === `lsp:msg:${sessionId}`)).toBe(true),
  )
  h.servers.send('w1', sessionId, { jsonrpc: '2.0', method: 'initialized', params: {} })
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-lsp-')))
  extensionDir = join(tmp, 'ext')
  workDir = join(tmp, 'work')
  mkdirSync(extensionDir)
  mkdirSync(join(workDir, 'pkg', 'src'), { recursive: true })
  writeFileSync(join(extensionDir, 'server.js'), '')
  writeFileSync(join(workDir, 'pkg', 'fake.toml'), '')
  writeFileSync(join(workDir, 'pkg', 'src', 'a.txt'), 'hello')
  writeFileSync(join(workDir, 'pkg', 'src', 'b.special.txt'), 'hello')
  writeFileSync(join(workDir, 'loose.txt'), 'hello')
})

afterEach(() => {
  for (const servers of live.splice(0)) servers.stopAll()
  rmSync(tmp, { recursive: true, force: true })
})

describe('scrubbedEnv', () => {
  it('drops every OSTIA_ variable and a stray ELECTRON_RUN_AS_NODE', () => {
    expect(
      scrubbedEnv({
        PATH: '/bin',
        OSTIA_TOKEN: 't',
        OSTIA_PANE_ID: 'p',
        ELECTRON_RUN_AS_NODE: '1',
      }),
    ).toEqual({ PATH: '/bin' })
  })
})

describe('findServerRoot', () => {
  const exists = (present: string[]) => (path: string) => present.includes(path)

  it('walks up to the nearest marker inside the workspace folder', () => {
    expect(
      findServerRoot(
        '/home/u/work/pkg/src/a.rs',
        ['Cargo.toml'],
        '/home/u/work',
        ['/home/u'],
        exists(['/home/u/work/pkg/Cargo.toml', '/home/u/work/Cargo.toml']),
      ),
    ).toBe('/home/u/work/pkg')
  })

  it('never climbs above the workspace folder, even when a marker sits higher', () => {
    expect(
      findServerRoot(
        '/home/u/work/src/a.rs',
        ['Cargo.toml'],
        '/home/u/work',
        ['/home/u'],
        exists(['/home/u/Cargo.toml']),
      ),
    ).toBe('/home/u/work')
  })

  it('uses the workspace folder when the server declares no markers', () => {
    expect(findServerRoot('/home/u/work/src/a.rs', [], '/home/u/work', ['/home/u'])).toBe(
      '/home/u/work',
    )
  })

  it('stops at the file root for a file outside the workspace folder', () => {
    expect(
      findServerRoot(
        '/home/u/other/a.rs',
        ['Cargo.toml'],
        '/home/u/work',
        ['/home/u'],
        exists(['/Cargo.toml', '/home/Cargo.toml']),
      ),
    ).toBe('/home/u/other')
  })

  it('uses the folder of a granted file that is outside every root', () => {
    expect(
      findServerRoot(
        '/etc/app/a.rs',
        ['Cargo.toml'],
        undefined,
        ['/home/u'],
        exists(['/etc/Cargo.toml']),
      ),
    ).toBe('/etc/app')
  })
})

describe('confinedScript', () => {
  it('returns the real path of a regular file inside the extension', () => {
    expect(confinedScript(extensionDir, 'server.js')).toBe(join(extensionDir, 'server.js'))
  })

  it('refuses a link that leaves the extension, a folder and a missing file', () => {
    writeFileSync(join(tmp, 'outside.js'), '')
    symlinkSync(join(tmp, 'outside.js'), join(extensionDir, 'link.js'))
    mkdirSync(join(extensionDir, 'dir.js'))
    expect(confinedScript(extensionDir, 'link.js')).toBeNull()
    expect(confinedScript(extensionDir, 'dir.js')).toBeNull()
    expect(confinedScript(extensionDir, 'missing.js')).toBeNull()
  })
})

describe('LanguageServers.open', () => {
  it('answers nothing to a window that does not own the pane or names no pane', async () => {
    const h = harness()
    const file = join(workDir, 'pkg', 'src', 'a.txt')
    expect(await h.servers.open('w2', 'p1', file)).toEqual([])
    expect(await h.servers.open('w1', 'missing', file)).toEqual([])
    expect(await h.servers.open('w1', 42, file)).toEqual([])
    expect(h.spawned).toHaveLength(0)
  })

  it('answers nothing for a file outside the confined roots', async () => {
    const h = harness()
    expect(await h.servers.open('w1', 'p1', '/etc/passwd.txt')).toEqual([])
    expect(h.spawned).toHaveLength(0)
  })

  it('spawns a bundled server with Electron as Node, a scrubbed environment and substituted arguments', async () => {
    const h = harness()
    const [session] = await h.servers.open('w1', 'p1', join(workDir, 'pkg', 'src', 'a.txt'))
    const root = join(workDir, 'pkg')
    expect(session).toEqual({
      sessionId: expect.any(String),
      serverKey: 'ext/fake',
      root,
      editRoot: root,
      languageId: 'fake',
      initializationOptions: { home: extensionDir, nested: { root } },
    })
    expect(h.spawned).toHaveLength(1)
    const [call] = h.spawned
    expect(call.command).toBe('/opt/ostia/electron')
    expect(call.args).toEqual([
      join(extensionDir, 'server.js'),
      '--stdio',
      `--ext=${extensionDir}`,
      `--root=${root}`,
    ])
    expect(call.options.cwd).toBe(root)
    expect(call.options.shell).toBe(false)
    expect(call.options.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      ELECTRON_RUN_AS_NODE: '1',
    })
  })

  it('names the document language by the longest matching file suffix, then by editor language', async () => {
    const h = harness()
    const [session] = await h.servers.open('w1', 'p1', join(workDir, 'pkg', 'src', 'b.special.txt'))
    expect(session.languageId).toBe('fake-special')
  })

  it('spawns a program server from its absolute path on PATH, without ELECTRON_RUN_AS_NODE', async () => {
    const h = harness()
    writeFileSync(join(workDir, 'main.rs'), '')
    const [session] = await h.servers.open('w1', 'p1', join(workDir, 'main.rs'))
    expect(session.serverKey).toBe('ext/prog')
    expect(session.root).toBe(workDir)
    expect(h.spawned[0].command).toBe('/usr/bin/prog-ls')
    expect(h.spawned[0].args).toEqual([])
    expect(h.spawned[0].options.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('starts nothing while the program is missing and reports it', async () => {
    const h = harness()
    h.programs.clear()
    writeFileSync(join(workDir, 'main.rs'), '')
    expect(await h.servers.open('w1', 'p1', join(workDir, 'main.rs'))).toEqual([])
    expect(h.spawned).toHaveLength(0)
    expect(h.servers.servers().find((s) => s.key === 'ext/prog')).toMatchObject({
      status: 'program-missing',
      program: 'prog-ls',
      requirement: 'lsp:ext/prog',
      kind: 'program',
    })
  })

  it('starts nothing for a server that is off or waiting for approval', async () => {
    const h = harness()
    h.sources = [source(nodeServer, { state: 'off' })]
    expect(await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))).toEqual([])
    h.sources = [source(nodeServer, { state: 'pending' })]
    expect(await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))).toEqual([])
    expect(h.servers.servers()[0].status).toBe('pending-approval')
    expect(h.spawned).toHaveLength(0)
  })

  it('refuses a script that is not a file inside the extension', async () => {
    const h = harness()
    h.sources = [source({ ...nodeServer, run: { node: 'missing.js', args: [] } })]
    expect(await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))).toEqual([])
    expect(h.spawned).toHaveLength(0)
    expect(h.servers.log('ext/fake').entries).toEqual([
      expect.objectContaining({ kind: 'spawn-failed', text: 'script-outside-extension' }),
    ])
  })
})

describe('LanguageServers sessions', () => {
  it('shares one process per server and root in a window, and starts another for a second root', async () => {
    const h = harness()
    const [a] = await h.servers.open('w1', 'p1', join(workDir, 'pkg', 'src', 'a.txt'))
    const [b] = await h.servers.open('w1', 'p1', join(workDir, 'pkg', 'src', 'b.special.txt'))
    const [c] = await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))
    expect(b.sessionId).toBe(a.sessionId)
    expect(c.sessionId).not.toBe(a.sessionId)
    expect(c.root).toBe(workDir)
    expect(h.spawned).toHaveLength(2)
    expect(h.servers.servers()[0]).toMatchObject({ status: 'running', folders: 2 })
  })

  it('starts one process when two documents open at the same moment', async () => {
    const h = harness()
    const [[a], [b]] = await Promise.all([
      h.servers.open('w1', 'p1', join(workDir, 'pkg', 'src', 'a.txt')),
      h.servers.open('w1', 'p1', join(workDir, 'pkg', 'src', 'b.special.txt')),
    ])
    expect(a.sessionId).toBe(b.sessionId)
    expect(h.spawned).toHaveLength(1)
  })

  it('gives each window its own process and stream', async () => {
    const h = harness({ workDir: () => workDir })
    const file = join(workDir, 'pkg', 'src', 'a.txt')
    const [first] = await h.servers.open('w1', 'p1', file)
    const [second] = await h.servers.open('w2', 'p2', file)
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(h.spawned).toHaveLength(2)
    h.spawned[1].child.peer.sendNotification('custom/ping', { n: 1 })
    await vi.waitFor(() => expect(h.posts).toHaveLength(1))
    expect(h.posts[0]).toMatchObject({ windowId: 'w2', channel: `lsp:msg:${second.sessionId}` })
  })

  it('does not offer a session whose process died while another server was starting', async () => {
    const h = harness()
    h.sources = [source(nodeServer), source(downloadServerFor('plaintext'))]
    h.fetchBinary.mockImplementation(async () => {
      h.spawned[0].child.exit(1, null)
      h.copies.set('ext/native', '/data/ls/ext/native/1.2.3/tool')
      return '/data/ls/ext/native/1.2.3/tool'
    })
    const offered = await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))
    expect(offered.map((s) => s.serverKey)).toEqual(['ext/native'])
  })

  it('hands nothing to a window that went away while its server was starting, and lets it idle out', async () => {
    const h = harness()
    h.sources = [source(downloadServerFor('plaintext'))]
    h.fetchBinary.mockImplementation(async () => {
      h.servers.dropWindow('w1')
      h.copies.set('ext/native', '/data/ls/ext/native/1.2.3/tool')
      return '/data/ls/ext/native/1.2.3/tool'
    })
    expect(await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))).toEqual([])
    await vi.waitFor(() => expect(h.spawned[0]?.child.exited).toBe(true))
  })

  it('tells a window that writes to a session that has ended, so its client stops waiting for an answer', async () => {
    const h = harness()
    const [session] = await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))
    h.spawned[0].child.exit(1, null)
    await vi.waitFor(() =>
      expect(h.posts.at(-1)).toMatchObject({ channel: `lsp:exit:${session.sessionId}` }),
    )
    const before = h.posts.length
    h.servers.send('w1', session.sessionId, { jsonrpc: '2.0', id: 9, method: 'initialize' })
    expect(h.posts.slice(before)).toEqual([
      { windowId: 'w1', channel: `lsp:exit:${session.sessionId}`, args: [] },
    ])
    h.servers.send('w1', 7, { jsonrpc: '2.0', id: 9, method: 'initialize' })
    h.servers.send('w1', 'anything:else', { jsonrpc: '2.0', id: 9, method: 'initialize' })
    expect(h.posts).toHaveLength(before + 1)
  })

  it('takes messages and releases only from the window that opened the session', async () => {
    const h = harness()
    const [session] = await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))
    const { child } = h.spawned[0]
    h.servers.send('w2', session.sessionId, { jsonrpc: '2.0', method: 'custom/fromOther' })
    h.servers.send('w1', session.sessionId, { jsonrpc: '2.0', method: 'custom/fromOwner' })
    h.servers.send('w1', session.sessionId, 'not a message')
    await vi.waitFor(() => expect(child.received).toHaveLength(1))
    expect(child.received[0].method).toBe('custom/fromOwner')
    h.servers.release('w2', session.sessionId)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(child.exited).toBe(false)
  })

  it('stops with shutdown then exit once no document has been open for the idle delay', async () => {
    const h = harness({ stopGraceMs: 10_000 })
    const file = join(workDir, 'loose.txt')
    const [session] = await h.servers.open('w1', 'p1', file)
    await h.servers.open('w1', 'p1', file)
    const { child } = h.spawned[0]
    await initialize(h, session.sessionId)
    h.servers.release('w1', session.sessionId)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(child.exited).toBe(false)
    h.servers.release('w1', session.sessionId)
    await vi.waitFor(() => expect(child.exited).toBe(true))
    expect(child.received.map((m) => m.method)).toEqual([
      'initialize',
      'initialized',
      'workspace/didChangeConfiguration',
      'shutdown',
      'exit',
    ])
    expect(child.signals).toEqual([])
    expect(h.posts.at(-1)).toMatchObject({
      windowId: 'w1',
      channel: `lsp:exit:${session.sessionId}`,
    })
    expect(h.servers.servers()[0]).toMatchObject({ status: 'idle', folders: 0 })
    expect(h.servers.log('ext/fake').entries.map((e) => e.kind)).toEqual([
      'start',
      'initialized',
      'stop',
      'exit',
    ])
  })

  it('keeps running when a document opens again before the idle delay ends', async () => {
    const h = harness()
    const file = join(workDir, 'loose.txt')
    const [session] = await h.servers.open('w1', 'p1', file)
    h.servers.release('w1', session.sessionId)
    const [again] = await h.servers.open('w1', 'p1', file)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(again.sessionId).toBe(session.sessionId)
    expect(h.spawned[0].child.exited).toBe(false)
  })

  it('kills a server that does not answer shutdown', async () => {
    const h = harness()
    const [session] = await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))
    const { child } = h.spawned[0]
    child.answersShutdown = false
    await initialize(h, session.sessionId)
    h.servers.release('w1', session.sessionId)
    await vi.waitFor(() => expect(child.exited).toBe(true))
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('restarts a crashed server with a doubling delay five times, then reports it crashed', async () => {
    const h = harness()
    const file = join(workDir, 'loose.txt')
    for (let attempt = 0; attempt <= 5; attempt++) {
      const [session] = await h.servers.open('w1', 'p1', file)
      expect(session, `attempt ${attempt}`).toBeDefined()
      h.spawned[attempt].child.exit(1, null)
    }
    expect(await h.servers.open('w1', 'p1', file)).toEqual([])
    expect(h.spawned).toHaveLength(6)
    expect(h.servers.servers()[0].status).toBe('crashed')
    const entries = h.servers.log('ext/fake').entries
    expect(entries.filter((e) => e.kind === 'restart')).toEqual(
      [1, 2, 4, 8, 16].map((delayMs, i) =>
        expect.objectContaining({ attempt: i + 1, limit: 5, delayMs }),
      ),
    )
    expect(entries.at(-1)?.kind).toBe('crashed')
  })

  it('starts again after the human restarts a crashed server', async () => {
    const h = harness()
    const file = join(workDir, 'loose.txt')
    for (let attempt = 0; attempt <= 5; attempt++) {
      await h.servers.open('w1', 'p1', file)
      h.spawned[attempt].child.exit(1, null)
    }
    await h.servers.restart('ext/fake')
    expect(await h.servers.open('w1', 'p1', file)).toHaveLength(1)
    expect(h.servers.servers()[0].status).toBe('running')
  })

  it('restart stops the running process without counting a crash', async () => {
    const h = harness()
    const file = join(workDir, 'loose.txt')
    const [session] = await h.servers.open('w1', 'p1', file)
    await h.servers.restart('ext/fake')
    expect(h.spawned[0].child.exited).toBe(true)
    const [next] = await h.servers.open('w1', 'p1', file)
    expect(next.sessionId).not.toBe(session.sessionId)
    expect(h.servers.log('ext/fake').entries.some((e) => e.kind === 'restart')).toBe(false)
  })

  it('stops a server that was switched off and a window that went away', async () => {
    const h = harness()
    await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))
    h.sources = [source(nodeServer, { state: 'off' })]
    h.servers.refresh()
    await vi.waitFor(() => expect(h.spawned[0].child.exited).toBe(true))
    expect(h.servers.servers()[0].status).toBe('off')

    h.sources = [source(nodeServer)]
    await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))
    h.servers.dropWindow('w1')
    await vi.waitFor(() => expect(h.spawned[1].child.exited).toBe(true))
  })
})

describe('LanguageServers configuration and log', () => {
  it('answers workspace/configuration itself, with the human’s setting laid over the defaults', async () => {
    const h = harness()
    h.sources = [source(nodeServer, { settingValues: { mode: 'loud' } })]
    const [session] = await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))
    const { child } = h.spawned[0]
    const answer = await child.peer.sendRequest('workspace/configuration', {
      items: [{ section: 'fake' }, { section: 'fake.mode' }, { section: 'missing.key' }, {}],
    })
    expect(answer).toEqual([
      { mode: 'loud', root: workDir },
      'loud',
      null,
      { fake: { mode: 'loud', root: workDir } },
    ])
    expect(h.posts.filter((p) => p.channel === `lsp:msg:${session.sessionId}`)).toEqual([])
  })

  it('hands a server its settings right after initialized, and nothing to a server that declares none', async () => {
    const h = harness()
    const [session] = await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))
    const { child } = h.spawned[0]
    await initialize(h, session.sessionId)
    await vi.waitFor(() =>
      expect(child.received.slice(1)).toEqual([
        { method: 'initialized', params: {} },
        {
          method: 'workspace/didChangeConfiguration',
          params: { settings: { fake: { mode: 'calm', root: workDir } } },
        },
      ]),
    )
    writeFileSync(join(workDir, 'main.rs'), '')
    const [plain] = await h.servers.open('w1', 'p1', join(workDir, 'main.rs'))
    await initialize(h, plain.sessionId)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.spawned[1].child.received.map((m) => m.method)).toEqual(['initialize', 'initialized'])
  })

  it('sends didChangeConfiguration to an initialized server when a mapped setting changes', async () => {
    const h = harness()
    const [session] = await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))
    const { child } = h.spawned[0]
    await initialize(h, session.sessionId)
    h.sources = [source(nodeServer, { settingValues: { mode: 'loud' } })]
    h.servers.refresh()
    await vi.waitFor(() =>
      expect(child.received.at(-1)).toEqual({
        method: 'workspace/didChangeConfiguration',
        params: { settings: { fake: { mode: 'loud', root: workDir } } },
      }),
    )
    h.servers.refresh()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      child.received.filter((m) => m.method === 'workspace/didChangeConfiguration'),
    ).toHaveLength(2)
  })

  it('logs the initialize result, failed requests by method and redacted stderr', async () => {
    const h = harness()
    const [session] = await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))
    const { child } = h.spawned[0]
    await initialize(h, session.sessionId)
    h.servers.send('w1', session.sessionId, { jsonrpc: '2.0', id: 2, method: 'fail' })
    h.servers.send('w1', session.sessionId, { jsonrpc: '2.0', id: 3, method: 'fail' })
    child.stderr.write('warming up\napi_key=abcdef123456\n')
    await vi.waitFor(() => expect(h.servers.log('ext/fake').errors).toEqual({ fail: 2 }))
    await vi.waitFor(() =>
      expect(h.servers.log('ext/fake').entries.filter((e) => e.kind === 'stderr')).toHaveLength(2),
    )
    const entries = h.servers.log('ext/fake').entries
    expect(entries[0]).toMatchObject({ kind: 'start', pid: 4242, sandboxed: false })
    expect(entries[1]).toMatchObject({ kind: 'initialized', name: 'fake', version: '9.9' })
    expect(entries.filter((e) => e.kind === 'stderr').map((e) => 'text' in e && e.text)).toEqual([
      'warming up',
      'api_key=[redacted]',
    ])
    expect(h.servers.log('unknown/key')).toEqual({ entries: [], errors: {} })
  })
})

describe('LanguageServers watched files', () => {
  function watching(): {
    h: Harness
    emit: (changes: { path: string; kind: 'created' | 'changed' | 'deleted' }[]) => void
    watchedRoots: string[]
    stopped: string[]
  } {
    const listeners = new Map<string, (changes: never[]) => void>()
    const watchedRoots: string[] = []
    const stopped: string[] = []
    const h = harness({
      watchTree: (root, onChange) => {
        watchedRoots.push(root)
        listeners.set(root, onChange as (changes: never[]) => void)
        return () => {
          stopped.push(root)
          listeners.delete(root)
        }
      },
    })
    return {
      h,
      watchedRoots,
      stopped,
      emit: (changes) => {
        for (const listener of [...listeners.values()]) listener(changes as never[])
      },
    }
  }

  function sentToServer(child: FakeChild): unknown[] {
    return child.received
      .filter((message) => message.method === 'workspace/didChangeWatchedFiles')
      .map((message) => message.params)
  }

  it('watches the session root once a server registers watchers and still forwards the request to the window', async () => {
    const { h, emit, watchedRoots } = watching()
    const [session] = await h.servers.open('w1', 'p1', join(workDir, 'pkg', 'src', 'a.txt'))
    await initialize(h, session.sessionId)
    const [{ child }] = h.spawned
    expect(watchedRoots).toEqual([])
    void child.peer.sendRequest('client/registerCapability', {
      registrations: [
        { id: 'hover', method: 'textDocument/hover' },
        {
          id: 'files',
          method: 'workspace/didChangeWatchedFiles',
          registerOptions: { watchers: [{ globPattern: '**/*.toml' }] },
        },
      ],
    })
    await vi.waitFor(() => expect(watchedRoots).toEqual([join(workDir, 'pkg')]))
    expect(
      h.posts.some(
        (post) => (post.args[0] as { method?: string }).method === 'client/registerCapability',
      ),
    ).toBe(true)
    emit([
      { path: join(workDir, 'pkg', 'fake.toml'), kind: 'changed' },
      { path: join(workDir, 'pkg', 'src', 'a.txt'), kind: 'changed' },
      { path: join(workDir, 'elsewhere.toml'), kind: 'created' },
    ])
    await vi.waitFor(() =>
      expect(sentToServer(child)).toEqual([
        { changes: [{ uri: `file://${join(workDir, 'pkg', 'fake.toml')}`, type: 2 }] },
      ]),
    )
  })

  it('stops watching when the last watcher is unregistered and when the server stops', async () => {
    const { h, stopped, watchedRoots } = watching()
    const [session] = await h.servers.open('w1', 'p1', join(workDir, 'pkg', 'src', 'a.txt'))
    await initialize(h, session.sessionId)
    const [{ child }] = h.spawned
    const register = (): void => {
      void child.peer.sendRequest('client/registerCapability', {
        registrations: [
          {
            id: 'files',
            method: 'workspace/didChangeWatchedFiles',
            registerOptions: { watchers: [{ globPattern: '**' }] },
          },
        ],
      })
    }
    register()
    await vi.waitFor(() => expect(watchedRoots).toHaveLength(1))
    void child.peer.sendRequest('client/unregisterCapability', {
      unregisterations: [{ id: 'files', method: 'workspace/didChangeWatchedFiles' }],
    })
    await vi.waitFor(() => expect(stopped).toHaveLength(1))
    register()
    await vi.waitFor(() => expect(watchedRoots).toHaveLength(2))
    await h.servers.restart('ext/fake')
    expect(stopped).toHaveLength(2)
  })

  it('watches nothing for a registration whose watchers all sit outside the session root', async () => {
    const { h, watchedRoots } = watching()
    const [session] = await h.servers.open('w1', 'p1', join(workDir, 'pkg', 'src', 'a.txt'))
    await initialize(h, session.sessionId)
    const [{ child }] = h.spawned
    void child.peer.sendRequest('client/registerCapability', {
      registrations: [
        {
          id: 'files',
          method: 'workspace/didChangeWatchedFiles',
          registerOptions: {
            watchers: [{ globPattern: { baseUri: `file://${tmp}`, pattern: '**' } }],
          },
        },
      ],
    })
    await vi.waitFor(() =>
      expect(
        h.posts.some(
          (post) => (post.args[0] as { method?: string }).method === 'client/registerCapability',
        ),
      ).toBe(true),
    )
    expect(watchedRoots).toEqual([])
  })
})

describe('LanguageServers with a program the human chose', () => {
  const chosen = { path: '/opt/mine/custom-ls', args: ['--verbose'] }

  it('runs the chosen program instead of the one on PATH, with the server’s arguments then the human’s', async () => {
    const h = harness({ overrideProblem: () => null })
    h.sources = [
      source(
        { ...programServer, run: { program: 'prog-ls', args: ['--stdio'] } },
        { override: chosen },
      ),
    ]
    writeFileSync(join(workDir, 'main.rs'), '')
    await h.servers.open('w1', 'p1', join(workDir, 'main.rs'))
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0].command).toBe('/opt/mine/custom-ls')
    expect(h.spawned[0].args).toEqual(['--stdio', '--verbose'])
    expect(h.spawned[0].options.shell).toBe(false)
    expect(h.spawned[0].options.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(h.servers.servers()[0]).toMatchObject({
      status: 'running',
      binary: { source: 'override' },
      override: chosen,
    })
  })

  it('replaces a bundled server’s runtime and script, and wins over a copy Ostia keeps', async () => {
    const h = harness({ overrideProblem: () => null })
    h.sources = [source(nodeServer, { override: { path: '/opt/mine/custom-ls', args: [] } })]
    h.copies.set('ext/fake', '/data/ls/ext/fake/1/bin/tool')
    await h.servers.open('w1', 'p1', join(workDir, 'pkg', 'src', 'a.txt'))
    const root = join(workDir, 'pkg')
    expect(h.spawned[0].command).toBe('/opt/mine/custom-ls')
    expect(h.spawned[0].args).toEqual(['--stdio', `--ext=${extensionDir}`, `--root=${root}`])
    expect(h.spawned[0].options.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('starts nothing, fetches nothing and says why when the chosen program can no longer run', async () => {
    const h = harness({ overrideProblem: () => 'not-executable' })
    h.sources = [source(programServer, { override: chosen })]
    writeFileSync(join(workDir, 'main.rs'), '')
    expect(await h.servers.open('w1', 'p1', join(workDir, 'main.rs'))).toEqual([])
    expect(h.spawned).toHaveLength(0)
    expect(h.fetchBinary).not.toHaveBeenCalled()
    expect(h.servers.servers()[0]).toMatchObject({
      status: 'override-invalid',
      override: { ...chosen, problem: 'not-executable' },
    })
    expect(h.servers.servers()[0].binary).toBeUndefined()
  })

  it('needs no system program for a server whose program the human chose', () => {
    const h = harness({ overrideProblem: () => null })
    h.sources = [source(programServer, { override: chosen })]
    h.programs.clear()
    h.servers.refresh()
    expect(h.requirements.size).toBe(0)
    expect(h.servers.servers()[0].status).toBe('idle')
  })

  it('restarts a running server when the human chooses another program', async () => {
    const h = harness({ overrideProblem: () => null })
    writeFileSync(join(workDir, 'main.rs'), '')
    h.sources = [source(programServer)]
    const [first] = await h.servers.open('w1', 'p1', join(workDir, 'main.rs'))
    expect(h.spawned[0].command).toBe('/usr/bin/prog-ls')
    h.sources = [source(programServer, { override: chosen })]
    h.servers.refresh()
    await vi.waitFor(() =>
      expect(h.posts.some((p) => p.channel === `lsp:exit:${first.sessionId}`)).toBe(true),
    )
    await h.servers.open('w1', 'p1', join(workDir, 'main.rs'))
    expect(h.spawned[1].command).toBe('/opt/mine/custom-ls')
  })

  it('is refused in a sandbox that cannot read the program or what it links to, naming the folder', async () => {
    const h = harness({
      overrideProblem: () => null,
      realPath: () => '/nix/store/abc/bin/custom-ls',
    })
    h.sources = [source(programServer, { override: chosen })]
    h.sandboxed.add('ws1')
    h.unreadable.add('/nix/store/abc/bin/custom-ls')
    writeFileSync(join(workDir, 'main.rs'), '')
    expect(await h.servers.open('w1', 'p1', join(workDir, 'main.rs'))).toEqual([])
    expect(h.spawned).toHaveLength(0)
    expect(h.servers.servers()[0]).toMatchObject({
      status: 'sandbox-unavailable',
      sandboxProblem: 'program-unreadable',
      sandboxDetail: '/nix/store/abc/bin',
    })
    h.unreadable.clear()
    await h.servers.restart('ext/prog')
    await h.servers.open('w1', 'p1', join(workDir, 'main.rs'))
    expect(h.wrap).toHaveBeenCalledWith('ws1', '/opt/mine/custom-ls --verbose', [])
  })
})

describe('LanguageServers requirements', () => {
  it('registers each program server as a system requirement and clears one that went away', () => {
    const h = harness()
    h.servers.refresh()
    expect([...h.requirements.keys()]).toEqual(['lsp:ext/prog'])
    expect(h.requirements.get('lsp:ext/prog')).toEqual({
      requirements: [
        { program: 'prog-ls', package: 'prog-pkg', platforms: ['linux', 'darwin', 'win32'] },
      ],
      label: 'Prog',
    })
    h.sources = [source(nodeServer)]
    h.servers.refresh()
    expect(h.requirements.size).toBe(0)
  })
})

describe('LanguageServers in a sandboxed workspace', () => {
  it('spawns only the wrapped command, through /bin/sh without a shell option', async () => {
    const h = harness()
    h.sandboxed.add('ws1')
    const [session] = await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))
    expect(session).toBeDefined()
    const script = join(extensionDir, 'server.js')
    expect(h.wrap).toHaveBeenCalledWith(
      'ws1',
      `/opt/ostia/electron ${script} --stdio '--ext=${extensionDir}' '--root=${workDir}'`,
      [],
    )
    const [call] = h.spawned
    expect(call.command).toBe('/bin/sh')
    expect(call.args).toEqual(['-c', expect.stringMatching(/^wrapped \/opt\/ostia\/electron /)])
    expect(call.options.shell).toBe(false)
    expect(call.options.env.TMPDIR).toBe('/sandbox-tmp')
    expect(call.options.env.OSTIA_TOKEN).toBeUndefined()
    expect(h.servers.log('ext/fake').entries[0]).toMatchObject({ kind: 'start', sandboxed: true })
  })

  it('lets the sandbox read a user-installed extension’s folder', async () => {
    const h = harness()
    h.sandboxed.add('ws1')
    h.sources = [source(nodeServer, { builtin: false })]
    await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))
    expect(h.wrap).toHaveBeenCalledWith('ws1', expect.any(String), [extensionDir])
  })

  it('keeps a sandboxed session apart from a host session for the same folder', async () => {
    const h = harness()
    const file = join(workDir, 'loose.txt')
    const [host] = await h.servers.open('w1', 'p1', file)
    h.sandboxed.add('ws1')
    const [boxed] = await h.servers.open('w1', 'p1', file)
    expect(boxed.sessionId).not.toBe(host.sessionId)
    expect(h.spawned).toHaveLength(2)
  })

  it('lets a sandboxed server edit files only inside the workspace folder', async () => {
    const h = harness({ workDir: () => join(workDir, 'pkg') })
    h.sandboxed.add('ws1')
    const [inside] = await h.servers.open('w1', 'p1', join(workDir, 'pkg', 'src', 'a.txt'))
    expect(inside.editRoot).toBe(join(workDir, 'pkg'))
    const [outside] = await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))
    expect(outside.root).toBe(workDir)
    expect(outside.editRoot).toBeNull()
  })

  it('announces a refusal once, not on every attempt', async () => {
    const h = harness()
    h.sandboxed.add('ws1')
    h.unreadable.add(workDir)
    const file = join(workDir, 'loose.txt')
    expect(await h.servers.open('w1', 'p1', file)).toEqual([])
    const announced = h.changed.mock.calls.length
    expect(announced).toBeGreaterThan(0)
    expect(await h.servers.open('w1', 'p1', file)).toEqual([])
    expect(await h.servers.open('w1', 'p1', file)).toEqual([])
    expect(h.changed.mock.calls.length).toBe(announced)
    expect(h.servers.servers()[0]).toMatchObject({
      status: 'sandbox-unavailable',
      sandboxProblem: 'folder-unreadable',
    })
  })

  it('spawns nothing when the wrap fails and says why', async () => {
    const h = harness()
    h.sandboxed.add('ws1')
    h.wrap.mockRejectedValueOnce(new Error('bwrap is missing'))
    expect(await h.servers.open('w1', 'p1', join(workDir, 'loose.txt'))).toEqual([])
    expect(h.spawned).toHaveLength(0)
    expect(h.servers.servers()[0]).toMatchObject({
      status: 'sandbox-unavailable',
      sandboxProblem: 'wrap-failed',
      sandboxDetail: 'bwrap is missing',
    })
  })

  it('spawns nothing when the sandbox cannot read the program, naming its folder', async () => {
    const h = harness()
    h.sandboxed.add('ws1')
    h.programs.set('prog-ls', '/home/u/.cargo/bin/prog-ls')
    h.unreadable.add('/home/u/.cargo/bin/prog-ls')
    writeFileSync(join(workDir, 'main.rs'), '')
    expect(await h.servers.open('w1', 'p1', join(workDir, 'main.rs'))).toEqual([])
    expect(h.spawned).toHaveLength(0)
    expect(h.wrap).not.toHaveBeenCalled()
    expect(h.servers.servers().find((s) => s.key === 'ext/prog')).toMatchObject({
      status: 'sandbox-unavailable',
      sandboxProblem: 'program-unreadable',
      sandboxDetail: '/home/u/.cargo/bin',
    })
  })
})

const downloadServer: LanguageServerContribution = {
  id: 'native',
  name: 'Native',
  languages: ['rust'],
  run: {
    download: {
      program: 'native-ls',
      version: '1.2.3',
      assets: {
        'linux-x64': {
          url: 'https://github.com/o/r/releases/download/1.2.3/native.gz',
          sha256: 'a'.repeat(64),
          archive: 'gz',
          executable: 'tool',
        },
      },
    },
    args: ['--lsp'],
  },
  rootMarkers: [],
}

function downloadServerFor(language: string): LanguageServerContribution {
  return { ...downloadServer, languages: [language] }
}

const goServer: LanguageServerContribution = {
  id: 'gopher',
  name: 'Gopher',
  languages: ['go'],
  run: {
    goInstall: { module: 'example.org/x/tools/gopher', version: 'v1.2.3', binary: 'gopher' },
    args: [],
  },
  rootMarkers: [],
}

describe('LanguageServers with a server Ostia fetches', () => {
  const rustFile = (): string => {
    writeFileSync(join(workDir, 'main.rs'), '')
    return join(workDir, 'main.rs')
  }
  const native = (h: Harness) => h.servers.servers().find((s) => s.key === 'ext/native')

  it('runs the human’s own program from PATH and never downloads', async () => {
    const h = harness()
    h.sources = [source(downloadServer)]
    h.programs.set('native-ls', '/usr/bin/native-ls')
    const [session] = await h.servers.open('w1', 'p1', rustFile())
    expect(session).toBeDefined()
    expect(h.spawned[0].command).toBe('/usr/bin/native-ls')
    expect(h.spawned[0].args).toEqual(['--lsp'])
    expect(h.fetchBinary).not.toHaveBeenCalled()
    expect(native(h)).toMatchObject({
      kind: 'download',
      status: 'running',
      version: '1.2.3',
      binary: { source: 'path' },
    })
  })

  it('runs its own copy of the pinned version when there is one', async () => {
    const h = harness()
    h.sources = [source(downloadServer)]
    h.copies.set('ext/native', '/data/ls/ext/native/1.2.3/tool')
    await h.servers.open('w1', 'p1', rustFile())
    expect(h.spawned[0].command).toBe('/data/ls/ext/native/1.2.3/tool')
    expect(h.fetchBinary).not.toHaveBeenCalled()
    expect(native(h)).toMatchObject({
      binary: { source: 'managed', version: '1.2.3' },
      managedCopy: true,
    })
  })

  it('downloads when a matching file opens, shows progress, then starts the server', async () => {
    const h = harness()
    h.sources = [source(downloadServer)]
    let finish: (path: string) => void = () => {}
    let progress: (percent: number) => void = () => {}
    h.fetchBinary.mockImplementation(
      (
        _extId: string,
        _serverId: string,
        _run: unknown,
        hooks: { onProgress: (n: number) => void },
      ) => {
        progress = hooks.onProgress
        return new Promise<string>((resolve) => {
          finish = (path) => {
            h.copies.set('ext/native', path)
            resolve(path)
          }
        })
      },
    )
    expect(native(h)).toMatchObject({ status: 'idle', fetchable: true })
    const opening = h.servers.open('w1', 'p1', rustFile())
    await vi.waitFor(() => expect(native(h)?.status).toBe('downloading'))
    progress(3)
    expect(native(h)?.progress).toBe(0)
    progress(40)
    expect(native(h)?.progress).toBe(40)
    expect(h.spawned).toHaveLength(0)
    finish('/data/ls/ext/native/1.2.3/tool')
    const [session] = await opening
    expect(session.serverKey).toBe('ext/native')
    expect(h.spawned[0].command).toBe('/data/ls/ext/native/1.2.3/tool')
    expect(native(h)).toMatchObject({ status: 'running', binary: { source: 'managed' } })
    expect(h.servers.log('ext/native').entries.slice(0, 2)).toEqual([
      expect.objectContaining({ kind: 'fetch-start', how: 'download', version: '1.2.3' }),
      expect.objectContaining({ kind: 'fetch-done', version: '1.2.3' }),
    ])
  })

  it('does not start a server that was switched off while its download ran', async () => {
    const h = harness()
    h.sources = [source(downloadServer)]
    h.fetchBinary.mockImplementation(async () => {
      h.sources = [source(downloadServer, { state: 'off' })]
      h.copies.set('ext/native', '/data/ls/ext/native/1.2.3/tool')
      return '/data/ls/ext/native/1.2.3/tool'
    })
    expect(await h.servers.open('w1', 'p1', rustFile())).toEqual([])
    expect(h.spawned).toHaveLength(0)
  })

  it('downloads once for two files that open together', async () => {
    const h = harness()
    h.sources = [source(downloadServer)]
    const file = rustFile()
    await Promise.all([h.servers.open('w1', 'p1', file), h.servers.open('w1', 'p1', file)])
    expect(h.fetchBinary).toHaveBeenCalledTimes(1)
    expect(h.spawned).toHaveLength(1)
  })

  it('reports a failed download with its reason and tries again only when the human asks', async () => {
    const h = harness()
    h.sources = [source(downloadServer)]
    h.fetchBinary.mockRejectedValueOnce(
      Object.assign(new Error('bad'), { reason: 'checksum-mismatch', detail: '' }),
    )
    const file = rustFile()
    expect(await h.servers.open('w1', 'p1', file)).toEqual([])
    expect(native(h)).toMatchObject({ status: 'download-failed', failure: 'checksum-mismatch' })
    expect(await h.servers.open('w1', 'p1', file)).toEqual([])
    expect(h.fetchBinary).toHaveBeenCalledTimes(1)
    expect(h.spawned).toHaveLength(0)

    await h.servers.fetch('ext/native')
    expect(h.fetchBinary).toHaveBeenCalledTimes(2)
    expect(native(h)).toMatchObject({ status: 'idle', managedCopy: true })
    expect(await h.servers.open('w1', 'p1', file)).toHaveLength(1)
  })

  it('never fetches for a server that is off or waiting for approval', async () => {
    const h = harness()
    h.sources = [source(downloadServer, { state: 'pending' })]
    await h.servers.open('w1', 'p1', rustFile())
    await h.servers.fetch('ext/native')
    h.sources = [source(downloadServer, { state: 'off' })]
    await h.servers.fetch('ext/native')
    expect(h.fetchBinary).not.toHaveBeenCalled()
  })

  it('treats a platform without an asset as PATH only and offers the program install', async () => {
    const h = harness()
    h.platformAsset = false
    h.sources = [source(downloadServer)]
    h.servers.refresh()
    expect(await h.servers.open('w1', 'p1', rustFile())).toEqual([])
    expect(h.fetchBinary).not.toHaveBeenCalled()
    expect(native(h)).toMatchObject({ status: 'program-missing', requirement: 'lsp:ext/native' })
    expect(h.requirements.get('lsp:ext/native')?.requirements).toEqual([
      { program: 'native-ls', package: 'native-ls', platforms: ['linux', 'darwin', 'win32'] },
    ])
  })

  it('lets the sandbox read only the folder of the copy it runs', async () => {
    const h = harness()
    h.sandboxed.add('ws1')
    h.sources = [source(downloadServer)]
    h.copies.set('ext/native', '/data/ls/ext/native/1.2.3/tool')
    h.unreadable.add('/data/ls/ext/native/1.2.3/tool')
    await h.servers.open('w1', 'p1', rustFile())
    expect(h.wrap).toHaveBeenCalledWith('ws1', '/data/ls/ext/native/1.2.3/tool --lsp', [
      '/data/ls/ext/native/1.2.3',
    ])
    expect(h.spawned).toHaveLength(1)
  })

  it('removes its copy on the human’s request and does not fetch it again until asked', async () => {
    const h = harness()
    h.sources = [source(downloadServer)]
    await h.servers.open('w1', 'p1', rustFile())
    await h.servers.removeDownload('ext/native')
    expect(h.spawned[0].child.exited).toBe(true)
    expect(h.copies.has('ext/native')).toBe(false)
    expect(native(h)).toMatchObject({ status: 'idle', fetchable: true, fetchHeld: true })
    expect(native(h)?.managedCopy).toBeUndefined()
    expect(h.servers.log('ext/native').entries.at(-1)?.kind).toBe('fetch-removed')
    expect(await h.servers.open('w1', 'p1', rustFile())).toEqual([])
    expect(h.fetchBinary).toHaveBeenCalledTimes(1)
    await h.servers.fetch('ext/native')
    expect(h.fetchBinary).toHaveBeenCalledTimes(2)
    expect(await h.servers.open('w1', 'p1', rustFile())).toHaveLength(1)
  })

  it('keeps only the pinned version of every declared server', () => {
    const h = harness()
    h.sources = [source(downloadServer), source(goServer, { state: 'off' }), source(nodeServer)]
    h.servers.refresh()
    expect(h.retained.at(-1)).toEqual(
      new Map([
        ['ext/native', '1.2.3'],
        ['ext/gopher', 'v1.2.3'],
      ]),
    )
  })

  it('installs with go when gopls is not on PATH, and says so when Go is missing', async () => {
    const h = harness()
    h.sources = [source(goServer)]
    h.servers.refresh()
    writeFileSync(join(workDir, 'main.go'), '')
    const gopher = () => h.servers.servers().find((s) => s.key === 'ext/gopher')
    expect(await h.servers.open('w1', 'p1', join(workDir, 'main.go'))).toEqual([])
    expect(h.fetchBinary).not.toHaveBeenCalled()
    expect(gopher()).toMatchObject({
      kind: 'go-install',
      status: 'toolchain-missing',
      requirement: 'lsp:ext/gopher',
      fetchCommand: 'go install example.org/x/tools/gopher@v1.2.3',
    })
    expect(h.requirements.get('lsp:ext/gopher')?.requirements).toEqual([
      { program: 'go', package: 'go', platforms: ['linux', 'darwin', 'win32'] },
    ])

    h.programs.set('go', '/usr/bin/go')
    const [session] = await h.servers.open('w1', 'p1', join(workDir, 'main.go'))
    expect(session.serverKey).toBe('ext/gopher')
    expect(h.fetchBinary).toHaveBeenCalledTimes(1)
    expect(h.servers.log('ext/gopher').entries[0]).toMatchObject({
      kind: 'fetch-start',
      how: 'go-install',
      version: 'v1.2.3',
    })
  })
})
