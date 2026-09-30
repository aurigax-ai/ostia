import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_ALLOWED_DOMAINS, DEFAULT_CONTROLS } from '../../shared/sandbox'
import { SandboxHost } from './hostClient'
import { buildSrtConfig } from './srtConfig'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/pine-test/sandbox-host-packages.mjs')

let root: string
let workDir: string
let host: SandboxHost
const blocked: string[] = []

function run(script: string): Promise<string> {
  return host.wrap(script, 'bash').then(
    (wrapped) =>
      new Promise((resolve) => {
        const child = spawn('/bin/sh', ['-c', wrapped], { cwd: workDir })
        let out = ''
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString('utf8')
        })
        child.stderr.on('data', (d: Buffer) => {
          out += d.toString('utf8')
        })
        child.on('close', () => resolve(out))
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-pkgfw-')))
  workDir = join(root, 'home', 'proj')
  mkdirSync(workDir, { recursive: true })
  host = new SandboxHost({
    nodePath: process.execPath,
    hostScript,
    onAsk: async () => false,
    onPackageBlocked: (pkg, reason) => blocked.push(`${pkg.name}@${pkg.version}:${reason}`),
  })
  await host.start(
    buildSrtConfig(
      { allowRead: [], domains: DEFAULT_ALLOWED_DOMAINS, controls: DEFAULT_CONTROLS },
      {
        home: join(root, 'home'),
        workDir,
        tmpDir: join(root, 'tmp'),
        dataDirs: [],
        socketPath: join(root, 'pine.sock'),
        runtimeReads: [],
      },
    ),
    {
      malware: true,
      cooldownDays: 2,
      denyList: ['npm:is-number'],
      allowOnly: null,
      allowances: [],
    },
  )
}, 60_000)

afterAll(() => {
  host?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('package firewall', () => {
  it('SBX-C80 lets an old, clean package download through the terminated TLS', async () => {
    const out = await run(
      'curl -s -m 40 -o /dev/null -w "code=%{http_code}\\n" https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
    )
    expect(out).toContain('code=200')
  }, 60_000)

  it('refuses a deny-listed package with a 403 that gives the reason, and reports it', async () => {
    const out = await run(
      'curl -s -m 40 -w "\\ncode=%{http_code}\\n" https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
    )
    expect(out).toContain('code=403')
    expect(out).toContain('deny-list')
    expect(blocked).toContain('is-number@7.0.0:deny-list')
  }, 60_000)
})
