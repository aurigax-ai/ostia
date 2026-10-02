import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SANDBOX_GLOBALS } from '../../shared/sandbox'
import type { SecretEntry } from '../../shared/secrets'
import { SandboxStore } from '../sandbox/store'
import { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import { prepareSecrets } from './secretInjection'
import { startSshAgent } from './sshAgent'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/pine-test/sandbox-host-secrets.mjs')

let root: string
let home: string
let workDir: string
let fakeBin: string
let manager: WorkspaceSandboxes
let realKey: string
let realFingerprint: string
const REAL_KEY_ENTRY: SecretEntry = {
  id: 'host:ssh:id_real',
  name: 'id_real',
  source: 'host',
  kind: 'ssh-key',
  editable: false,
}

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nKEY-MATERIAL\n'
const LIST: SecretEntry[] = [
  {
    id: 'host:env:GITHUB_TOKEN',
    name: 'GITHUB_TOKEN',
    source: 'host',
    kind: 'env',
    editable: false,
  },
  {
    id: 'host:ssh:id_ed25519',
    name: 'id_ed25519',
    source: 'host',
    kind: 'ssh-key',
    editable: false,
  },
  { id: 'host:ssh:id_gone', name: 'id_gone', source: 'host', kind: 'ssh-key', editable: false },
]
const VALUES: Record<string, string> = {
  'host:env:GITHUB_TOKEN': 'ghp_real_value',
  'host:ssh:id_ed25519': KEY,
}

function runIn(ws: string, script: string, env: Record<string, string>): Promise<string> {
  return manager.wrap(ws, script, 'bash').then((wrapped) =>
    execFileSync('/bin/sh', ['-c', wrapped], {
      cwd: workDir,
      encoding: 'utf8',
      env: { ...process.env, ...env, PATH: `${fakeBin}:${process.env.PATH}` },
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-secret-inject-')))
  home = join(root, 'home')
  workDir = join(home, 'proj')
  fakeBin = join(root, 'bin')
  mkdirSync(workDir, { recursive: true })
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(join(home, '.ssh', 'id_ed25519'), KEY)
  realKey = join(root, 'id_real')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', realKey])
  realFingerprint = execFileSync('ssh-keygen', ['-lf', realKey], { encoding: 'utf8' }).split(' ')[1]
  mkdirSync(fakeBin)
  writeFileSync(join(fakeBin, 'ssh'), '#!/bin/sh\necho "SSH-ARGS $*"\n')
  chmodSync(join(fakeBin, 'ssh'), 0o755)
  const store = new SandboxStore(join(root, 'sandbox.json'))
  for (const ws of ['a', 'b']) {
    store.set(ws, { enabled: true, allowRead: [], domains: [], controls: {} })
  }
  manager = new WorkspaceSandboxes({
    store,
    globals: () => DEFAULT_SANDBOX_GLOBALS,
    basePaths: () => ({
      home,
      dataDirs: [],
      socketPath: join(root, 'pine.sock'),
      runtimeReads: [fakeBin],
    }),
    workDir: () => workDir,
    tmpRoot: join(root, 'sandbox-tmp'),
    nodePath: process.execPath,
    hostScript,
    onAsk: async () => false,
  })
}, 60_000)

afterAll(() => {
  manager?.stopAll()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('secret injection', () => {
  it('SBX-C70 puts an env-granted secret in the sandboxed shell as its real value', async () => {
    const prepared = prepareSecrets({
      grants: [{ id: 'host:env:GITHUB_TOKEN', mode: 'env' }],
      list: LIST,
      value: (id) => VALUES[id] ?? null,
      dir: join(manager.tmpDir('a'), 'secrets'),
    })
    expect(await runIn('a', 'echo "token=$GITHUB_TOKEN"', prepared.env)).toContain(
      'token=ghp_real_value',
    )
  })

  it('SBX-C71 gives git the file-granted SSH key through an agent while ~/.ssh stays hidden', async () => {
    const dir = join(manager.tmpDir('a'), 'secrets')
    const prepared = prepareSecrets({
      grants: [{ id: 'host:ssh:id_real', mode: 'file' }],
      list: [...LIST, REAL_KEY_ENTRY],
      value: (id) => (id === 'host:ssh:id_real' ? readFileSync(realKey, 'utf8') : null),
      dir,
    })
    const agent = await startSshAgent(manager.sshAgentSocket('a'), prepared.sshKeys)
    try {
      const out = await runIn(
        'a',
        `head -1 "$PINE_SECRETS_DIR/id_real"; cat ${home}/.ssh/id_ed25519 2>&1 | head -1; ssh-add -l`,
        { ...prepared.env, SSH_AUTH_SOCK: agent.socket },
      )
      expect(out).toContain('BEGIN OPENSSH PRIVATE KEY')
      expect(out).not.toContain('KEY-MATERIAL')
      expect(out).toContain(realFingerprint)
    } finally {
      agent.stop()
    }
  }, 30_000)

  it('SBX-C73 keeps one workspace file secret unreadable from another sandboxed workspace', async () => {
    const dir = join(manager.tmpDir('a'), 'secrets')
    prepareSecrets({
      grants: [{ id: 'host:ssh:id_ed25519', mode: 'file' }],
      list: LIST,
      value: (id) => VALUES[id] ?? null,
      dir,
    })
    const out = await runIn('b', `cat ${join(dir, 'id_ed25519')} 2>&1; true`, {})
    expect(out).not.toContain('KEY-MATERIAL')
  })

  it('SBX-C72 removes the workspace secrets folder when the workspace closes', () => {
    const dir = join(manager.tmpDir('a'), 'secrets')
    prepareSecrets({
      grants: [{ id: 'host:ssh:id_ed25519', mode: 'file' }],
      list: LIST,
      value: (id) => VALUES[id] ?? null,
      dir,
    })
    expect(existsSync(join(dir, 'id_ed25519'))).toBe(true)
    manager.forget('a')
    expect(existsSync(dir)).toBe(false)
  })

  it('SBX-C69 reports a granted host secret that disappeared and injects the rest', () => {
    const prepared = prepareSecrets({
      grants: [
        { id: 'host:ssh:id_gone', mode: 'file' },
        { id: 'host:env:GITHUB_TOKEN', mode: 'env' },
      ],
      list: LIST,
      value: (id) => VALUES[id] ?? null,
      dir: join(manager.tmpDir('b'), 'secrets'),
    })
    expect(prepared.missing).toEqual(['id_gone'])
    expect(prepared.env.GITHUB_TOKEN).toBe('ghp_real_value')
  })
})
