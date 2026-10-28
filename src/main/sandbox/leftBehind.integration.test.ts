import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONTROLS } from '../../shared/sandbox/sandbox'
import { SandboxHost } from './hostClient'
import { leftBehindBaseline, leftBehindSince } from './leftBehind'
import { buildSrtConfig } from './srtConfig'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-left-behind.mjs')

let root: string
let home: string
let workDir: string
let existingDir: string
const hosts: SandboxHost[] = []

function run(
  host: SandboxHost,
  cwd: string,
  script: string,
): Promise<{ code: number; out: string }> {
  return host.wrap(script, 'bash').then(
    (wrapped) =>
      new Promise((resolve) => {
        const child = spawn('/bin/sh', ['-c', wrapped], { cwd, env: { ...process.env } })
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

async function startHost(dir: string, tmp: string): Promise<SandboxHost> {
  const host = new SandboxHost({ nodePath: process.execPath, hostScript, onAsk: async () => false })
  hosts.push(host)
  mkdirSync(tmp, { recursive: true })
  await host.start(
    buildSrtConfig(
      { allowRead: [], domains: [], controls: DEFAULT_CONTROLS },
      {
        home,
        workDir: dir,
        tmpDir: tmp,
        dataDirs: [join(home, '.local/share/ostia')],
        socketPath: join(root, 'ostia.sock'),
        runtimeReads: [],
      },
    ),
  )
  return host
}

async function listedWhileRunning(host: SandboxHost, cwd: string, tmp: string): Promise<string[]> {
  const started = join(tmp, 'started')
  const release = join(tmp, 'release')
  const running = run(
    host,
    cwd,
    `ls -A > ${started}; while [ ! -e ${release} ]; do sleep 0.05; done`,
  )
  for (let i = 0; i < 200 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 50))
  const listed = readdirSync(cwd).sort()
  writeFileSync(release, '')
  await running
  return listed
}

beforeAll(async () => {
  await build({
    entryPoints: [join(repoRoot, 'src/main/sandbox/host.ts')],
    outfile: hostScript,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['@anthropic-ai/sandbox-runtime'],
  })
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-sbx-left-')))
  home = join(root, 'home')
  workDir = join(home, 'proj')
  existingDir = join(home, 'existing')
  for (const d of [workDir, existingDir, join(home, '.claude/projects')])
    mkdirSync(d, { recursive: true })
  writeFileSync(join(existingDir, '.envrc'), 'original\n')
}, 60_000)

afterAll(() => {
  for (const host of hosts) host.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('files a sandbox leaves behind', () => {
  it('SBX-C102 leaves no empty .envrc in a folder that has none while the sandbox runs', async () => {
    const host = await startHost(workDir, join(root, 'tmp-a'))
    const res = await run(host, workDir, 'ls -A; true')
    expect(res.out).not.toContain('.envrc')
    expect(existsSync(join(workDir, '.envrc'))).toBe(false)
  }, 60_000)

  it('SBX-C103 keeps an existing .envrc unwritable inside the sandbox', async () => {
    const host = await startHost(existingDir, join(root, 'tmp-b'))
    await run(host, existingDir, 'echo evil > .envrc; rm -f .envrc; true')
    expect(readFileSync(join(existingDir, '.envrc'), 'utf8')).toBe('original\n')
  }, 60_000)

  it('SBX-C104 lists a planted .envrc, a nested repository and its hook after the session', async () => {
    const host = await startHost(workDir, join(root, 'tmp-c'))
    const baseline = await leftBehindBaseline(workDir)
    await run(
      host,
      workDir,
      'echo evil > .envrc; mkdir -p sub/deep && git init -q sub/deep && echo evil > sub/deep/.git/hooks/pre-commit; echo ok > plain.txt; true',
    )
    host.stop()
    await new Promise((resolve) => setTimeout(resolve, 500))
    const found = await leftBehindSince(workDir, baseline)
    expect(found).toEqual(['.envrc', 'sub/deep/.git'])
  }, 60_000)

  it('SBX-C105 lists nothing for a session that only wrote ordinary files', async () => {
    const dir = join(home, 'quiet')
    mkdirSync(dir)
    execFileSync('git', ['init', '-q', dir])
    const host = await startHost(dir, join(root, 'tmp-d'))
    const baseline = await leftBehindBaseline(dir)
    await run(
      host,
      dir,
      'echo x > f.txt && git add f.txt && git -c user.email=a@b -c user.name=n commit -q -m c; true',
    )
    host.stop()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await leftBehindSince(dir, baseline)).toEqual([])
  }, 60_000)

  it('SBX-C109 leaves an empty folder empty while the shell runs and after it', async () => {
    const dir = join(home, 'empty')
    mkdirSync(dir)
    const tmp = join(root, 'tmp-e')
    const host = await startHost(dir, tmp)
    expect(await listedWhileRunning(host, dir, tmp)).toEqual([])
    expect(readFileSync(join(tmp, 'started'), 'utf8')).toBe('')
    expect(readdirSync(dir)).toEqual([])
  }, 60_000)

  it('SBX-C110 hides an existing project vault and makes no .git or .envrc beside it', async () => {
    const dir = join(home, 'vaulted')
    mkdirSync(join(dir, '.ostia'), { recursive: true })
    writeFileSync(join(dir, '.ostia/vault.json'), '{"K":"VAULT-CIPHER"}')
    const tmp = join(root, 'tmp-f')
    const host = await startHost(dir, tmp)
    const res = await run(host, dir, 'cat .ostia/vault.json; rm -f .ostia/vault.json; true')
    expect(res.out).not.toContain('VAULT-CIPHER')
    expect(readFileSync(join(dir, '.ostia/vault.json'), 'utf8')).toContain('VAULT-CIPHER')
    expect(await listedWhileRunning(host, dir, tmp)).toEqual(['.ostia'])
  }, 60_000)

  it('SBX-C111 lists a repository created in the folder root of a folder that had none', async () => {
    const dir = join(home, 'fresh')
    mkdirSync(dir)
    const host = await startHost(dir, join(root, 'tmp-g'))
    const baseline = await leftBehindBaseline(dir)
    await run(host, dir, 'git init -q . && echo evil > .git/hooks/pre-commit; true')
    host.stop()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await leftBehindSince(dir, baseline)).toEqual(['.git'])
  }, 60_000)
})
