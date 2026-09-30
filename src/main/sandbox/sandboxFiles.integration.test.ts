import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONTROLS } from '../../shared/sandbox'
import { SandboxHost } from './hostClient'
import { buildSrtConfig } from './srtConfig'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/pine-test/sandbox-host-files.mjs')

let root: string
let home: string
let workDir: string
let dataDir: string
let host: SandboxHost

function run(script: string): Promise<{ code: number; out: string }> {
  return host.wrap(script, 'bash').then(
    (wrapped) =>
      new Promise((resolve) => {
        const child = spawn('/bin/sh', ['-c', wrapped], { cwd: workDir, env: { ...process.env } })
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-sbx-files-')))
  home = join(root, 'home')
  workDir = join(home, 'proj')
  dataDir = join(home, '.local/share/pine')
  for (const d of [workDir, dataDir, join(home, '.claude/projects')])
    mkdirSync(d, { recursive: true })
  writeFileSync(join(dataDir, 'vault.json'), '{"K":"VAULT-CIPHER"}')
  execFileSync('git', ['init', '-q', workDir])
  execFileSync('git', ['-C', workDir, 'config', 'user.email', 't@example.com'])
  execFileSync('git', ['-C', workDir, 'config', 'user.name', 'T'])
  host = new SandboxHost({ nodePath: process.execPath, hostScript, onAsk: async () => false })
  await host.start(
    buildSrtConfig(
      { allowRead: [dataDir, '~/.local/share/pine'], domains: [], controls: DEFAULT_CONTROLS },
      {
        home,
        workDir,
        tmpDir: join(root, 'tmp'),
        dataDirs: [dataDir],
        socketPath: join(root, 'pine.sock'),
        runtimeReads: [],
      },
    ),
  )
}, 60_000)

afterAll(() => {
  host?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('sandboxed files', () => {
  it('SBX-C23 keeps Pine data hidden even when the human lists it as readable', async () => {
    const res = await run(`cat ${dataDir}/vault.json; true`)
    expect(res.out).not.toContain('VAULT-CIPHER')
  })

  it('SBX-C29 lets an agent CLI save its session under ~/.claude', async () => {
    await run(`echo session > ${home}/.claude/projects/s.jsonl`)
    expect(readFileSync(join(home, '.claude/projects/s.jsonl'), 'utf8')).toBe('session\n')
  })

  it('SBX-C31 commits in the repo while hooks, git config and .envrc stay unwritable', async () => {
    const res = await run(
      `cd ${workDir} && echo x > f.txt && git add f.txt && git commit -q -m c && echo COMMITTED; echo evil > .git/hooks/pre-commit; echo '[core]' >> .git/config; echo evil > .envrc; true`,
    )
    expect(res.out).toContain('COMMITTED')
    expect(execFileSync('git', ['-C', workDir, 'log', '--oneline']).toString()).toContain('c')
    const hook = join(workDir, '.git/hooks/pre-commit')
    expect(existsSync(hook) ? readFileSync(hook, 'utf8') : '').not.toContain('evil')
    expect(readFileSync(join(workDir, '.git/config'), 'utf8')).not.toContain('[core]\n[core]')
    const envrc = join(workDir, '.envrc')
    expect(existsSync(envrc) ? readFileSync(envrc, 'utf8') : '').not.toContain('evil')
  })

  it('SBX-C34 leaves the last write in place when the host and the sandbox write at once', async () => {
    const file = join(workDir, 'shared.txt')
    const sandboxed = run(`for i in $(seq 1 50); do echo sandbox > ${file}; done`)
    for (let i = 0; i < 50; i++) writeFileSync(file, 'host\n')
    const res = await sandboxed
    expect(res.code).toBe(0)
    expect(['host\n', 'sandbox\n']).toContain(readFileSync(file, 'utf8'))
    expect(readdirSync(workDir).filter((f) => f.startsWith('shared'))).toEqual(['shared.txt'])
  })
})
