import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SANDBOX_GLOBALS } from '../../shared/sandbox/sandbox'
import { sandboxFailureBanner } from './spawnBanner'
import { sandboxSpawnEnv } from './spawnEnv'
import { SandboxStore } from './store'
import { SandboxUnavailableError, WorkspaceSandboxes } from './workspaceSandboxes'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-ws.mjs')

let root: string
let workDir: string
let storePath: string
let noBwrapPath: string

function sandboxes(store: SandboxStore, env?: NodeJS.ProcessEnv): WorkspaceSandboxes {
  return new WorkspaceSandboxes({
    store,
    globals: () => DEFAULT_SANDBOX_GLOBALS,
    basePaths: () => ({
      home: join(root, 'home'),
      dataDirs: [],
      socketPath: join(root, 'ostia.sock'),
      runtimeReads: [],
    }),
    workDir: () => workDir,
    tmpRoot: join(root, 'tmp'),
    nodePath: process.execPath,
    hostScript,
    hostEnv: env,
    onAsk: async () => false,
  })
}

beforeAll(async () => {
  await build({
    entryPoints: [join(repoRoot, 'src/main/sandbox/host.ts')],
    outfile: hostScript,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  })
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-wsbx-')))
  workDir = join(root, 'home', 'proj')
  mkdirSync(workDir, { recursive: true })
  storePath = join(root, 'sandbox.json')
  noBwrapPath = join(root, 'bin')
  mkdirSync(noBwrapPath)
  for (const tool of ['rg', 'socat', 'sh', 'bash', 'which']) {
    symlinkSync(`/usr/bin/${tool}`, join(noBwrapPath, tool))
  }
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceSandboxes', () => {
  it.skipIf(process.platform === 'darwin')(
    'SBX-C9 fails closed and names bubblewrap when bwrap is missing (Linux only: bubblewrap)',
    async () => {
      const store = new SandboxStore(join(root, 'c9.json'))
      store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {} })
      const manager = sandboxes(store, { ...process.env, PATH: noBwrapPath })
      const failure = await manager.wrap('ws', 'bash', 'bash').catch((err: unknown) => err)
      expect(failure).toBeInstanceOf(SandboxUnavailableError)
      const { message, missing } = failure as SandboxUnavailableError
      const banner = sandboxFailureBanner(message, missing)
      expect(banner).toContain('bubblewrap')
      expect(banner).toContain('ostia system install bubblewrap')
      expect(banner).not.toContain('socat')
      manager.stopAll()
    },
  )

  it.skipIf(process.platform === 'darwin')(
    'SBX-C11 starts sandboxed once the missing package is there, after a failed attempt (Linux only: bubblewrap)',
    async () => {
      const store = new SandboxStore(join(root, 'c11.json'))
      store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {} })
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: noBwrapPath }
      const manager = sandboxes(store, env)
      await expect(manager.wrap('ws', 'bash', 'bash')).rejects.toBeInstanceOf(
        SandboxUnavailableError,
      )
      env.PATH = process.env.PATH
      const wrapped = await manager.wrap('ws', 'bash', 'bash')
      expect(wrapped).toContain('bwrap')
      manager.stopAll()
    },
    30_000,
  )

  it('SBX-C12 keeps a sandboxed workspace and its stored domains across a restart, but not grants until restart', async () => {
    const first = new SandboxStore(storePath)
    first.set('ws', { enabled: true, allowRead: [], domains: ['example.com'], controls: {} })
    const before = sandboxes(first)
    before.allowUntilRestart('ws', 'session-only.example.org')
    expect(before.config('ws').network.allowedDomains).toContain('session-only.example.org')
    const after = sandboxes(new SandboxStore(storePath))
    expect(after.isEnabled('ws')).toBe(true)
    const domains = after.config('ws').network.allowedDomains
    expect(domains).toContain('example.com')
    expect(domains).not.toContain('session-only.example.org')
  })

  it('SBX-C15 reports a corrupt sandbox file and fails every sandboxed spawn closed', async () => {
    const path = join(root, 'corrupt.json')
    writeFileSync(path, '{ not json')
    const store = new SandboxStore(path)
    expect(store.isCorrupt).toBe(true)
    const manager = sandboxes(store)
    expect(manager.isEnabled('any-workspace')).toBe(true)
    await expect(manager.wrap('any-workspace', 'bash', 'bash')).rejects.toThrow(/unreadable/)
    store.set('any-workspace', { enabled: false, allowRead: [], domains: [], controls: {} })
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
  })

  it('SBX-C17 removes the workspace entry and its tmp dir when the workspace closes', () => {
    const path = join(root, 'c17.json')
    const store = new SandboxStore(path)
    store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {} })
    const manager = sandboxes(store)
    manager.config('ws')
    expect(existsSync(manager.tmpDir('ws'))).toBe(true)
    manager.forget('ws')
    expect(new SandboxStore(path).has('ws')).toBe(false)
    expect(existsSync(manager.tmpDir('ws'))).toBe(false)
  })

  it('SBX-C25 lets a shell read a path the human added to its workspace, and not other workspaces', async () => {
    const notes = join(root, 'home', 'notes')
    mkdirSync(notes, { recursive: true })
    writeFileSync(join(notes, 'n.txt'), 'NOTE-CONTENT')
    const store = new SandboxStore(join(root, 'c25.json'))
    store.set('a', { enabled: true, allowRead: ['~/notes'], domains: [], controls: {} })
    store.set('b', { enabled: true, allowRead: [], domains: [], controls: {} })
    const readIn = async (manager: WorkspaceSandboxes, ws: string): Promise<string> => {
      const wrapped = await manager.wrap(ws, `cat ${join(notes, 'n.txt')} 2>&1; true`, 'bash')
      return execFileSync('/bin/sh', ['-c', wrapped], { cwd: workDir, encoding: 'utf8' })
    }
    const managerA = sandboxes(store)
    const managerB = sandboxes(store)
    expect(await readIn(managerA, 'a')).toContain('NOTE-CONTENT')
    const inB = await readIn(managerB, 'b')
    expect(inB).not.toContain('NOTE-CONTENT')
    expect(inB).toContain(
      process.platform === 'darwin' ? 'Operation not permitted' : 'No such file or directory',
    )
    managerA.stopAll()
    managerB.stopAll()
  }, 30_000)

  it('SBX-C56 keeps an inherited ssh-agent socket out of reach and out of the environment', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'ostia-c56-agent-'))
    const agentSock = join(agentDir, 'agent.sock')
    const server = createServer((socket) => socket.end('AGENT-REACHED'))
    await new Promise<void>((resolve) => server.listen(agentSock, resolve))
    try {
      const env = sandboxSpawnEnv({ PATH: '/usr/bin', SSH_AUTH_SOCK: agentSock, KEEP: '1' })
      expect(env).toEqual({ PATH: '/usr/bin', KEEP: '1' })
      const store = new SandboxStore(join(root, 'c56.json'))
      store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {} })
      const manager = new WorkspaceSandboxes({
        store,
        globals: () => DEFAULT_SANDBOX_GLOBALS,
        basePaths: () => ({
          home: join(root, 'home'),
          dataDirs: [],
          socketPath: join(root, 'ostia.sock'),
          runtimeReads: [],
          agentSockets: [agentSock],
        }),
        workDir: () => workDir,
        tmpRoot: join(root, 'tmp'),
        nodePath: process.execPath,
        hostScript,
        onAsk: async () => false,
      })
      const probe = `node -e "require('net').connect('${agentSock}').on('data',d=>console.log(String(d))).on('error',e=>console.log('ERR',e.code))"`
      const wrapped = await manager.wrap('ws', probe, 'bash')
      const out = execFileSync('/bin/sh', ['-c', wrapped], { cwd: workDir, encoding: 'utf8' })
      expect(out).not.toContain('AGENT-REACHED')
      manager.stopAll()
    } finally {
      server.close()
      rmSync(agentDir, { recursive: true, force: true })
    }
  }, 30_000)
})
