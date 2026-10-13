import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SANDBOX_GLOBALS } from '../../shared/sandbox/sandbox'
import { SandboxStore } from './store'
import {
  type KeptSandboxHosts,
  WorkspaceSandboxes,
  type WorkspaceSandboxesDeps,
} from './workspaceSandboxes'

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

function sandboxes(
  store: SandboxStore,
  kept: KeptSandboxHosts,
  extra: Partial<WorkspaceSandboxesDeps> = {},
): WorkspaceSandboxes {
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
    ...extra,
  })
}

async function upstream(): Promise<{ env: NodeJS.ProcessEnv; close: () => void }> {
  const server = createServer((_req, res) => res.end('UPSTREAM'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    env: { ...process.env, HTTP_PROXY: url, http_proxy: url, NO_PROXY: '', no_proxy: '' },
    close: () => server.close(),
  }
}

function shell(wrapped: string) {
  const child = spawn('/bin/sh', ['-c', wrapped], { cwd: workDir })
  children.push(child)
  let out = ''
  child.stdout.on('data', (d: Buffer) => {
    out += d.toString('utf8')
  })
  const done = new Promise((resolve) => child.on('close', resolve))
  return { child, done, out: () => out }
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

  it.skipIf(process.platform === 'darwin')(
    'KSH-C50 keeps a sandboxed shell reaching an allowed domain through a restart, with no restart to apply',
    async () => {
      const proxy = await upstream()
      try {
        const store = new SandboxStore(join(root, 'c50.json'))
        store.set('ws-c50', { enabled: true, allowRead: [], domains: [], controls: {} })
        const first = keptHosts()
        const before = sandboxes(store, first.kept, { hostEnv: proxy.env })
        const wrapped = await before.wrap(
          'ws-c50',
          'for i in $(seq 1 30); do curl -s -m 5 -o /dev/null -w "n$i=%{http_code} " http://kept.ostia-e2e.test/b; sleep 0.2; done',
          'bash',
        )
        const stamp = before.wrapStamp('ws-c50')
        before.update('ws-c50', (current) => ({ ...current, domains: ['kept.ostia-e2e.test'] }))
        await before.refresh('ws-c50')
        const loop = shell(wrapped)
        await expect.poll(loop.out, { timeout: 10_000 }).toContain('n2=')
        before.releaseAll()
        const [host] = first.spawned
        await expect.poll(loop.out, { timeout: 10_000 }).toContain('n8=')

        const second = keptHosts({ channel: host?.channel ?? '', tmpDir: host?.tmpDir ?? '' })
        const after = sandboxes(store, second.kept, { hostEnv: proxy.env })
        await after.connect('ws-c50')
        expect(after.wrapStamp('ws-c50')).toBe(stamp)
        await loop.done
        expect(loop.out().trim().split(' ')).toEqual(
          Array.from({ length: 30 }, (_, i) => `n${i + 1}=200`),
        )
        after.stopAll()
      } finally {
        proxy.close()
      }
    },
    60_000,
  )

  it.skipIf(process.platform === 'darwin')(
    'KSH-C51 asks the next Ostia about a new domain a sandboxed shell requested while Ostia was closed',
    async () => {
      const proxy = await upstream()
      try {
        const store = new SandboxStore(join(root, 'c51.json'))
        store.set('ws-c51', { enabled: true, allowRead: [], domains: [], controls: {} })
        const first = keptHosts()
        const before = sandboxes(store, first.kept, { hostEnv: proxy.env })
        const asking = join(workDir, 'c51-asking')
        const request = shell(
          await before.wrap(
            'ws-c51',
            `read -r _; touch ${asking}; curl -s -m 20 -o /dev/null -w "later=%{http_code}" http://later.ostia-e2e.test/x`,
            'bash',
          ),
        )
        before.releaseAll()
        await new Promise((r) => setTimeout(r, 200))
        request.child.stdin.end('\n')
        await expect.poll(() => existsSync(asking), { timeout: 10_000 }).toBe(true)
        await new Promise((r) => setTimeout(r, 1000))

        const [host] = first.spawned
        const asked: string[] = []
        const second = keptHosts({ channel: host?.channel ?? '', tmpDir: host?.tmpDir ?? '' })
        const after = sandboxes(store, second.kept, {
          hostEnv: proxy.env,
          onAsk: async (_id, domain) => {
            asked.push(domain)
            return true
          },
        })
        await after.connect('ws-c51')
        await request.done
        expect(asked).toEqual(['later.ostia-e2e.test'])
        expect(request.out()).toBe('later=200')
        after.stopAll()
      } finally {
        proxy.close()
      }
    },
    60_000,
  )

  it.skipIf(process.platform === 'darwin')(
    'KSH-C56 keeps the temp folder of a kept sandbox through a quit and the next start',
    async () => {
      const store = new SandboxStore(join(root, 'c56.json'))
      store.set('ws-c56', { enabled: true, allowRead: [], domains: [], controls: {} })
      const first = keptHosts(undefined, 'tmp/kept-c56')
      const before = sandboxes(store, first.kept)
      const kept = shell(
        await before.wrap(
          'ws-c56',
          'touch "$TMPDIR/kept-marker" && echo marked; read -r _; [ -f "$TMPDIR/kept-marker" ] && echo tmp-kept || echo tmp-gone',
          'bash',
        ),
      )
      await expect.poll(kept.out, { timeout: 10_000 }).toContain('marked')
      before.releaseAll()
      before.clearTmp(false)

      const [host] = first.spawned
      const second = keptHosts(
        { channel: host?.channel ?? '', tmpDir: host?.tmpDir ?? '' },
        'tmp/kept-c56',
      )
      const after = sandboxes(store, second.kept)
      after.adoptKeptTmp('ws-c56', host?.tmpDir ?? '')
      after.sweepKeptTmp(['ws-c56'])
      after.sweepTmp()
      await after.connect('ws-c56')
      kept.child.stdin.end('\n')
      await kept.done
      expect(kept.out()).toContain('tmp-kept')
      after.stopAll()
    },
    30_000,
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
