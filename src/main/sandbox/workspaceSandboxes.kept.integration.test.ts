import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SANDBOX_GLOBALS } from '../../shared/sandbox/sandbox'
import { SandboxStore } from './store'
import { type KeptSandboxHosts, WorkspaceSandboxes } from './workspaceSandboxes'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-kept.mjs')
let root: string
let workDir: string
const children: ChildProcess[] = []

beforeAll(async () => {
  await build({
    entryPoints: [join(repoRoot, 'src/main/sandbox/host.ts')],
    outfile: hostScript,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  })
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-kept-sbx-')))
  workDir = join(root, 'home', 'proj')
  mkdirSync(workDir, { recursive: true })
  mkdirSync(join(root, 'channels'), { mode: 0o700 })
})

afterAll(() => {
  for (const child of children) child.kill()
  if (root) rmSync(root, { recursive: true, force: true })
})

function alive(pid: number | undefined): boolean {
  try {
    process.kill(pid ?? -1, 0)
    return true
  } catch {
    return false
  }
}

function keptHosts(claimable?: { channel: string; tmpDir: string }, tmpRoot = 'kept-tmp') {
  const spawned: { pid?: number; channel: string; tmpDir: string }[] = []
  const kept: KeptSandboxHosts = {
    enabled: () => true,
    tmpRoot: join(root, tmpRoot),
    channel: (id) => join(root, 'channels', `${id}.sock`),
    claim: () => claimable,
    spawn: async (_id, spec) => {
      const child = spawn(spec.file, spec.args, { env: spec.env, stdio: 'ignore', detached: true })
      children.push(child)
      spawned.push({ pid: child.pid, channel: spec.channel, tmpDir: spec.tmpDir })
    },
    stop: () => undefined,
  }
  return { kept, spawned }
}

function sandboxes(store: SandboxStore, kept: KeptSandboxHosts): WorkspaceSandboxes {
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
    onAsk: async () => false,
    kept,
  })
}

describe('WorkspaceSandboxes with kept hosts', () => {
  it.skipIf(process.platform === 'darwin')(
    'starts a kept host, lets it outlive a restart and wraps through it again',
    async () => {
      const store = new SandboxStore(join(root, 'kept.json'))
      store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {} })
      const first = keptHosts()
      const before = sandboxes(store, first.kept)
      expect(await before.wrap('ws', 'echo hi', 'bash')).toContain('echo hi')
      const [host] = first.spawned
      expect(host?.tmpDir.startsWith(join(root, 'kept-tmp'))).toBe(true)
      before.releaseAll()
      await new Promise((r) => setTimeout(r, 200))
      expect(alive(host?.pid)).toBe(true)

      const second = keptHosts({ channel: host?.channel ?? '', tmpDir: host?.tmpDir ?? '' })
      const after = sandboxes(store, second.kept)
      expect(await after.wrap('ws', 'echo again', 'bash')).toContain('echo again')
      expect(second.spawned).toEqual([])
      expect(after.tmpDir('ws')).toBe(host?.tmpDir)
      after.stopAll()
      await expect.poll(() => alive(host?.pid), { timeout: 5000 }).toBe(false)
    },
  )

  it.skipIf(process.platform === 'darwin')(
    'KSH-C64 starts a plain host when tmux cannot keep one, and wraps through it',
    async () => {
      const store = new SandboxStore(join(root, 'fallback.json'))
      store.set('ws-fallback', { enabled: true, allowRead: [], domains: [], controls: {} })
      const { kept } = keptHosts()
      kept.spawn = async () => {
        throw new Error('tmux could not start its server')
      }
      const manager = sandboxes(store, kept)
      expect(await manager.wrap('ws-fallback', 'echo plain', 'bash')).toContain('echo plain')
      expect(manager.isKept('ws-fallback')).toBe(false)
      manager.stopAll()
    },
  )

  it.skipIf(process.platform === 'darwin')(
    'starts a plain host when the kept host channel path is too long for a socket',
    async () => {
      const store = new SandboxStore(join(root, 'long.json'))
      store.set('ws-long', { enabled: true, allowRead: [], domains: [], controls: {} })
      const { kept, spawned } = keptHosts()
      kept.channel = (id) => join(root, 'x'.repeat(120), `${id}.sock`)
      const manager = sandboxes(store, kept)
      expect(await manager.wrap('ws-long', 'echo plain', 'bash')).toContain('echo plain')
      expect(spawned).toEqual([])
      expect(manager.isKept('ws-long')).toBe(false)
      manager.stopAll()
    },
  )

  it('KSH-C57 removes a kept tmp folder whose workspace keeps nothing and keeps the live one', () => {
    const store = new SandboxStore(join(root, 'sweep.json'))
    const { kept } = keptHosts(undefined, 'sweep-tmp')
    const manager = sandboxes(store, kept)
    const live = manager.tmpDir('live')
    const stale = join(kept.tmpRoot, 'stalefolder')
    mkdirSync(live, { recursive: true })
    mkdirSync(stale, { recursive: true })
    expect(manager.sweepKeptTmp(['live'])).toEqual([stale])
    expect(existsSync(live)).toBe(true)
    expect(existsSync(stale)).toBe(false)
  })
})
