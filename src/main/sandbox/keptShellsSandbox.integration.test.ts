import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONTROLS } from '../../shared/sandbox'
import { programPath } from '../systemRequirements'
import { SandboxHost } from './hostClient'
import { buildSrtConfig, withKeptShells } from './srtConfig'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-kept-paths.mjs')
const tmux = programPath('tmux') ?? 'tmux'

let root: string
let tmuxDir: string
let socket: string
let host: SandboxHost

function run(script: string): Promise<{ code: number; out: string }> {
  return host.wrap(script, 'bash').then(
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
  await host.start(
    buildSrtConfig(
      { allowRead: [], domains: [], controls: DEFAULT_CONTROLS },
      {
        ...withKeptShells(
          { home, dataDirs: [], socketPath: join(root, 'ostia.sock'), runtimeReads: [] },
          {
            tmuxDir,
            socketPath: join(root, 'kept.sock'),
            launcherDir: join(root, 'bin'),
          },
        ),
        workDir,
        tmpDir: join(root, 'tmp'),
      },
    ),
  )
}, 60_000)

afterAll(() => {
  host?.stop()
  try {
    execFileSync(tmux, ['-S', socket, 'kill-server'])
  } catch {}
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'darwin')('a sandbox and the kept-shells tmux server', () => {
  it('KSH-C54 a sandboxed shell cannot list or reach the tmux socket folder', async () => {
    const listed = await run(
      `ls ${tmuxDir}; [ -S ${socket} ] && echo socket-visible || echo socket-hidden`,
    )
    expect(listed.out).not.toContain('kept')
    expect(listed.out).toContain('socket-hidden')
  })

  it('KSH-C55 a sandboxed shell cannot use tmux to type into a pane outside the sandbox', async () => {
    const sent = await run(`${tmux} -S ${socket} send-keys -t k 'echo escaped' Enter; echo rc=$?`)
    expect(sent.out).toMatch(/rc=[1-9]/)
    const panes = execFileSync(tmux, ['-S', socket, 'capture-pane', '-p', '-t', 'k'], {
      encoding: 'utf8',
    })
    expect(panes).not.toContain('escaped')
  })
})
