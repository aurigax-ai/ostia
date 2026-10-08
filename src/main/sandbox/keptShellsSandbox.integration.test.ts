import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { skipWithoutTmux, tmuxPath } from '../../../test/tmux'
import { DEFAULT_CONTROLS } from '../../shared/sandbox'
import { SandboxHost } from './hostClient'
import { buildSrtConfig, withKeptShells } from './srtConfig'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-kept-paths.mjs')
const tmux = tmuxPath ?? 'tmux'

let root: string
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
  tmuxDir = join(root, 'tmux')
  mkdirSync(workDir, { recursive: true })
  mkdirSync(tmuxDir, { mode: 0o700 })
  socket = join(tmuxDir, 'kept')
  execFileSync(tmux, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'k', 'sleep 120'])
  host = new SandboxHost({ nodePath: process.execPath, hostScript, onAsk: async () => false })
  config = buildSrtConfig(
    { allowRead: [], domains: [], controls: DEFAULT_CONTROLS },
    {
      ...withKeptShells(
        { home, dataDirs: [], socketPath: join(root, 'ostia.sock'), runtimeReads: [] },
        { tmuxDir, socketPath: join(root, 'kept.sock') },
      ),
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
      expect(listed.out).not.toContain('kept')
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
