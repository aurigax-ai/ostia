import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type FakeRegistry, startFakeRegistry } from '../../../test/fixtures/sandbox/fakeRegistry'
import { DEFAULT_ALLOWED_DOMAINS, DEFAULT_CONTROLS } from '../../shared/sandbox/sandbox'
import { SandboxHost } from '../sandbox/hostClient'
import { buildSrtConfig } from '../sandbox/srtConfig'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-packages.mjs')
const redirectScript = join(repoRoot, 'test/fixtures/sandbox/redirectToFakeRegistry.mjs')

let root: string
let workDir: string
let host: SandboxHost
let registry: FakeRegistry
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
    external: ['@anthropic-ai/sandbox-runtime'],
  })
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-pkgfw-')))
  workDir = join(root, 'home', 'proj')
  mkdirSync(workDir, { recursive: true })
  registry = await startFakeRegistry(join(root, 'fake-registry'))
  host = new SandboxHost({
    nodePath: process.execPath,
    hostScript,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import ${redirectScript}`,
      NODE_EXTRA_CA_CERTS: registry.caPath,
      OSTIA_FAKE_REGISTRY_PORT: String(registry.port),
    },
    onAsk: async () => false,
    onPackageBlocked: (pkg, reason) => blocked.push(`${pkg.name}@${pkg.version}:${reason}`),
  })
  await host.start(
    buildSrtConfig(
      {
        allowRead: [],
        domains: [...DEFAULT_ALLOWED_DOMAINS, '127.0.0.1'],
        controls: DEFAULT_CONTROLS,
      },
      {
        home: join(root, 'home'),
        workDir,
        tmpDir: join(root, 'tmp'),
        dataDirs: [],
        socketPath: join(root, 'ostia.sock'),
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

afterAll(async () => {
  host?.stop()
  await registry?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('package firewall', () => {
  it('SBX-C80 lets an old, clean package download through the terminated TLS', async () => {
    const out = await run(
      `curl -s -m 40 -w "\\ncode=%{http_code}\\n" https://registry.npmjs.org:${registry.port}/left-pad/-/left-pad-1.3.0.tgz | tail -c 400`,
    )
    expect(out).toContain('code=200')
  }, 60_000)

  it('refuses a deny-listed package with a 403 that gives the reason, and reports it', async () => {
    const out = await run(
      `curl -s -m 40 -w "\\ncode=%{http_code}\\n" https://registry.npmjs.org:${registry.port}/is-number/-/is-number-7.0.0.tgz`,
    )
    expect(out).toContain('code=403')
    expect(out).toContain('deny-list')
    expect(blocked).toContain('is-number@7.0.0:deny-list')
  }, 60_000)
})
