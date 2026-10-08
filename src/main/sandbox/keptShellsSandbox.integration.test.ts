import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { skipWithoutTmux, tmuxPath } from '../../../test/tmux'
import { DEFAULT_CONTROLS } from '../../shared/sandbox'
import { SandboxHost } from './hostClient'
import { buildSrtConfig } from './srtConfig'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-kept-paths.mjs')
const tmux = tmuxPath ?? 'tmux'

let root: string
let userData: string
let tmuxDir: string
let socket: string
let host: SandboxHost
let config: SandboxRuntimeConfig

function run(script: string, extraReads: string[] = []): Promise<{ code: number; out: string }> {
  const custom =
    extraReads.length > 0
      ? {
          filesystem: {
            ...config.filesystem,
            allowRead: [...(config.filesystem.allowRead ?? []), ...extraReads],
          },
        }
      : undefined
  return host.wrap(script, 'bash', custom).then(
    (wrapped) =>
      new Promise((resolve) => {
        const child = spawn('/bin/sh', ['-c', wrapped], { env: { ...process.env } })
        let out = ''
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString('utf8')
        })
        child.stderr.on('data', (d: Buffer) => {
          out += d.toString('utf8')
        })
        child.on('close', (code) => resolve({ code: code ?? -1, out }))
      }),
  )
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-kept-paths-')))
  const home = join(root, 'home')
  const workDir = join(home, 'proj')
  userData = join(root, 'userData')
  tmuxDir = join(userData, 'kept-shells')
  mkdirSync(workDir, { recursive: true })
  mkdirSync(tmuxDir, { recursive: true, mode: 0o700 })
  socket = join(tmuxDir, 'kept')
  execFileSync(tmux, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'k', 'sleep 120'])
  host = new SandboxHost({ nodePath: process.execPath, hostScript, onAsk: async () => false })
  config = buildSrtConfig(
    { allowRead: [], domains: [], controls: DEFAULT_CONTROLS },
    {
      home,
      dataDirs: [userData],
      socketPath: join(root, 'ostia.sock'),
      keptSocketPath: join(root, 'kept.sock'),
      runtimeReads: [],
      workDir,
      tmpDir: join(root, 'tmp'),
    },
  )
  await host.start(config)
}, 60_000)

afterAll(() => {
  host?.stop()
  try {
    execFileSync(tmux, ['-S', socket, 'kill-server'])
  } catch {}
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'darwin' || skipWithoutTmux)(
  'a sandbox and the kept-shells tmux server',
  () => {
    it('KSH-C54 a sandboxed shell cannot list or reach the tmux socket folder', async () => {
      const listed = await run(
        `ls ${tmuxDir}; [ -S ${socket} ] && echo socket-visible || echo socket-hidden`,
      )
      expect(listed.out).not.toMatch(/^kept$/m)
      expect(listed.out).toContain('socket-hidden')
    })

    it('KSH-C73 a sandboxed kept shell reads its own token file, a new token written in place, and nothing else in the folder', async () => {
      const tokens = join(tmuxDir, 'tokens', 'kept')
      mkdirSync(tokens, { recursive: true, mode: 0o700 })
      const own = join(tokens, 'own')
      const other = join(tokens, 'other')
      writeFileSync(own, 'first-token', { mode: 0o600 })
      writeFileSync(other, 'other-token', { mode: 0o600 })
      const script = `cat ${own}; echo; cat ${other} 2>/dev/null || echo other-hidden; [ -S ${socket} ] && echo socket-visible || echo socket-hidden`
      const first = await run(script, [own])
      expect(first.out).toContain('first-token')
      expect(first.out).toContain('other-hidden')
      expect(first.out).not.toContain('other-token')
      expect(first.out).toContain('socket-hidden')
      const wrapped = await host.wrap(`echo ready; read -r _; cat ${own}`, 'bash', {
        filesystem: {
          ...config.filesystem,
          allowRead: [...(config.filesystem.allowRead ?? []), own],
        },
      })
      const child = spawn('/bin/sh', ['-c', wrapped])
      let out = ''
      const ready = new Promise<void>((resolve) => {
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString('utf8')
          if (out.includes('ready\n')) resolve()
        })
      })
      await ready
      writeFileSync(own, 'second-token', { mode: 0o600 })
      child.stdin.end('\n')
      await new Promise((resolve) => child.on('close', resolve))
      out = out.replace('ready\n', '')
      expect(out).toBe('second-token')
    })

    it('KSH-C83 a sandboxed shell started before the tmux folder exists cannot see it once it is created', async () => {
      const late = join(userData, 'late-kept-shells')
      const outside = join(root, 'late-outside')
      const probe = (dir: string, tag: string): string =>
        `[ -e ${dir} ] && echo ${tag}-visible || echo ${tag}-hidden; [ -S ${join(dir, 'sock')} ] && echo ${tag}-socket-visible || echo ${tag}-socket-hidden`
      const wrapped = await host.wrap(
        `echo ready; read -r _; ${probe(late, 'data')}; ${probe(outside, 'outside')}`,
        'bash',
      )
      const child = spawn('/bin/sh', ['-c', wrapped])
      let out = ''
      const ready = new Promise<void>((resolve) => {
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString('utf8')
          if (out.includes('ready\n')) resolve()
        })
      })
      await ready
      const servers = [late, outside].map((dir) => {
        mkdirSync(dir, { mode: 0o700 })
        return createServer().listen(join(dir, 'sock'))
      })
      await Promise.all(servers.map((s) => new Promise((resolve) => s.once('listening', resolve))))
      child.stdin.end('\n')
      await new Promise((resolve) => child.on('close', resolve))
      for (const server of servers) server.close()
      expect(out).toContain('data-hidden')
      expect(out).toContain('data-socket-hidden')
      expect(out).toContain('outside-socket-visible')
    })

    it('KSH-C84 a sandboxed kept shell can write its own state file and leaves every other file in the folder untouched', async () => {
      const tokens = join(tmuxDir, 'tokens', 'kept')
      mkdirSync(tokens, { recursive: true, mode: 0o700 })
      const own = join(tokens, 'mine.state')
      const other = join(tokens, 'theirs.state')
      writeFileSync(own, '', { mode: 0o600 })
      writeFileSync(other, '', { mode: 0o600 })
      const wrapped = await host.wrap(
        `echo '{"state":"waiting"}' > ${own}; echo x > ${other} 2>/dev/null; true`,
        'bash',
        {
          filesystem: {
            ...config.filesystem,
            allowRead: [...(config.filesystem.allowRead ?? []), own],
            allowWrite: [...config.filesystem.allowWrite, own],
          },
        },
      )
      const child = spawn('/bin/sh', ['-c', wrapped])
      await new Promise((resolve) => child.on('close', resolve))
      expect(readFileSync(own, 'utf8').trim()).toBe('{"state":"waiting"}')
      expect(readFileSync(other, 'utf8')).toBe('')
    })

    it('KSH-C55 a sandboxed shell cannot use tmux to type into a pane outside the sandbox', async () => {
      const sent = await run(`${tmux} -S ${socket} send-keys -t k 'echo escaped' Enter; echo rc=$?`)
      expect(sent.out).toMatch(/rc=[1-9]/)
      const panes = execFileSync(tmux, ['-S', socket, 'capture-pane', '-p', '-t', 'k'], {
        encoding: 'utf8',
      })
      expect(panes).not.toContain('escaped')
    })
  },
)
