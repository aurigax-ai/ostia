import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONTROLS } from '../../shared/sandbox/sandbox'
import { hookLinkTargets } from './hookLinks'
import { SandboxHost } from './hostClient'
import { buildSrtConfig } from './srtConfig'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-hook-links.mjs')

let root: string
let home: string
let workDir: string
let tools: string
let host: SandboxHost

function run(script: string): Promise<string> {
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-sbx-hooks-')))
  home = join(root, 'home')
  workDir = join(home, 'proj')
  tools = join(home, 'tools/hooks')
  const dataDir = join(home, '.local/share/ostia')
  const hooks = join(home, '.claude/hooks')
  for (const d of [workDir, tools, hooks, dataDir, join(tools, 'sub')])
    mkdirSync(d, { recursive: true })
  writeFileSync(join(tools, 'remind.sh'), '#!/bin/sh\necho HOOK-RAN\n')
  chmodSync(join(tools, 'remind.sh'), 0o755)
  writeFileSync(join(tools, 'sibling.txt'), 'SIBLING-SECRET')
  writeFileSync(join(tools, 'sub/inner.txt'), 'INNER-SECRET')
  writeFileSync(join(dataDir, 'vault.json'), 'VAULT-SECRET')
  symlinkSync(join(tools, 'remind.sh'), join(hooks, 'remind.sh'))
  symlinkSync(join(tools, 'sub'), join(hooks, 'dir-link'))
  symlinkSync(join(dataDir, 'vault.json'), join(hooks, 'vault-link'))
  symlinkSync(join(tools, 'missing.sh'), join(hooks, 'dangling'))
  writeFileSync(join(hooks, 'plain.sh'), '#!/bin/sh\necho PLAIN\n')
  const base = {
    home,
    dataDirs: [dataDir],
    socketPath: join(root, 'ostia.sock'),
    runtimeReads: [],
  }
  host = new SandboxHost({ nodePath: process.execPath, hostScript, onAsk: async () => false })
  await host.start(
    buildSrtConfig(
      { allowRead: [], domains: [], controls: DEFAULT_CONTROLS },
      {
        ...base,
        workDir,
        tmpDir: join(root, 'tmp'),
        hookLinks: hookLinkTargets(home),
      },
    ),
  )
}, 60_000)

afterAll(() => {
  host?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('Claude hooks that are links in a sandbox', () => {
  it('runs a hook whose link points into a hidden folder and keeps the rest of that folder hidden', async () => {
    const out = await run(
      `${home}/.claude/hooks/remind.sh; cat ${tools}/sibling.txt; cat ${tools}/sub/inner.txt; ls ${tools}`,
    )
    expect(out).toContain('HOOK-RAN')
    expect(out).not.toContain('SIBLING-SECRET')
    expect(out).not.toContain('INNER-SECRET')
  })

  it('exposes the target read-only', async () => {
    const out = await run(
      `echo changed >> ${tools}/remind.sh; echo write=$?; rm -f ${tools}/remind.sh; echo rm=$?; echo x > ${tools}/new.sh; echo new=$?`,
    )
    expect(out).toContain('write=1')
    expect(existsSync(join(tools, 'new.sh'))).toBe(false)
    expect(readFileSync(join(tools, 'remind.sh'), 'utf8')).toBe('#!/bin/sh\necho HOOK-RAN\n')
  })

  it('does not expose a link to a folder, to Ostia data or to nothing', async () => {
    const out = await run(
      `cat ${home}/.claude/hooks/dir-link/inner.txt; cat ${home}/.claude/hooks/vault-link; cat ${tools}/sub/inner.txt; true`,
    )
    expect(out).not.toContain('INNER-SECRET')
    expect(out).not.toContain('VAULT-SECRET')
  })

  it('lists only regular targets', () => {
    expect(hookLinkTargets(home)).toEqual(
      expect.arrayContaining([
        join(tools, 'remind.sh'),
        join(home, '.local/share/ostia/vault.json'),
      ]),
    )
    expect(hookLinkTargets(home)).not.toContain(join(tools, 'sub'))
    expect(hookLinkTargets(home)).toHaveLength(2)
  })
})
