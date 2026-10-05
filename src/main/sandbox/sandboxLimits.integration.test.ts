import { spawn } from 'node:child_process'
import {
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
import { PRODUCT_DISPLAY_NAME } from '../../shared/productDisplay'
import {
  DEFAULT_SANDBOX_GLOBALS,
  type SandboxViolation,
  type WorkspaceSandbox,
} from '../../shared/sandbox'
import { sandboxFailureBanner } from './spawnBanner'
import { SandboxStore } from './store'
import { ViolationLog, recordViolations } from './violations'
import { SandboxUnavailableError, WorkspaceSandboxes } from './workspaceSandboxes'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-limits.mjs')
const linux = process.platform === 'linux'
const seatbeltOrBwrap = linux || process.platform === 'darwin'

let root: string
let home: string
let workDir: string
let dataDir: string

const BASE: WorkspaceSandbox = { enabled: true, allowRead: [], domains: [], controls: {} }

function start(name: string, settings: Partial<WorkspaceSandbox>, folder = workDir) {
  const store = new SandboxStore(join(root, `${name}.json`))
  store.set('ws', { ...BASE, ...settings })
  const log = new ViolationLog()
  const sandboxes: WorkspaceSandboxes = new WorkspaceSandboxes({
    store,
    globals: () => ({ ...DEFAULT_SANDBOX_GLOBALS, allowRead: [] }),
    basePaths: () => ({
      home,
      dataDirs: [dataDir],
      socketPath: join(root, 'ostia.sock'),
      runtimeReads: [],
    }),
    workDir: () => folder,
    tmpRoot: join(root, 'tmp', name),
    nodePath: process.execPath,
    hostScript,
    onAsk: async () => false,
    onViolations: (workspaceId, lines) =>
      recordViolations(
        log,
        (path) => sandboxes.writeRefusal(workspaceId, path),
        workspaceId,
        lines,
      ),
  })
  const run = async (script: string): Promise<string> => {
    const wrapped = await sandboxes.wrap('ws', script, 'bash')
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', wrapped], {
        cwd: folder,
        env: { ...process.env, HOME: home },
      })
      let out = ''
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      child.stderr.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      child.on('close', () => resolve(out))
    })
  }
  const violations = async (
    wanted: (v: SandboxViolation) => boolean,
  ): Promise<SandboxViolation[]> => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !log.list('ws').some(wanted)) {
      await new Promise((r) => setTimeout(r, 50))
    }
    return log.list('ws')
  }
  return { sandboxes, store, run, violations }
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-limits-')))
  home = join(root, 'home')
  workDir = join(home, 'proj')
  dataDir = join(home, '.local/share/ostia')
  for (const dir of [
    workDir,
    dataDir,
    join(home, 'builds/release'),
    join(home, 'notes/private'),
    join(workDir, 'secrets'),
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(join(home, 'notes/readme.txt'), 'NOTES-README')
  writeFileSync(join(home, 'notes/private/key.txt'), 'PRIVATE-KEY')
  writeFileSync(join(workDir, 'secrets/token.txt'), 'WORKSPACE-TOKEN')
  writeFileSync(join(dataDir, 'vault.json'), 'VAULT-CONTENTS')
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!seatbeltOrBwrap)(
  'sandbox filesystem limits in a real sandbox (Seatbelt and bwrap)',
  () => {
    it('lets a sandboxed command write to a folder the human made writable, and nowhere else in home', async () => {
      const { sandboxes, run } = start('write', { allowWrite: ['~/builds'] })
      const out = await run(
        `echo built > ${home}/builds/out.txt && echo WRITE-OK; echo x > ${home}/notes/new.txt; ls ${home}/builds`,
      )
      sandboxes.stopAll()
      expect(out).toContain('WRITE-OK')
      expect(readFileSync(join(home, 'builds/out.txt'), 'utf8')).toBe('built\n')
      expect(existsSync(join(home, 'notes/new.txt'))).toBe(false)
    }, 60_000)

    it('reads ~/.cargo when it is readable but never its credentials', async () => {
      mkdirSync(join(home, '.cargo/bin'), { recursive: true })
      writeFileSync(join(home, '.cargo/bin/tool'), 'CARGO-TOOL')
      writeFileSync(join(home, '.cargo/credentials.toml'), 'CRATES-TOKEN')
      const { sandboxes, run } = start('cargo', { allowRead: ['~/.cargo'] })
      const out = await run(
        `cat ${home}/.cargo/bin/tool; echo; cat ${home}/.cargo/credentials.toml; cat ${home}/.cargo/credentials; echo CARGO-DONE`,
      )
      sandboxes.stopAll()
      expect(out).toContain('CARGO-TOOL')
      expect(out).toContain('CARGO-DONE')
      expect(out).not.toContain('CRATES-TOKEN')
      expect(existsSync(join(home, '.cargo/credentials'))).toBe(false)
    }, 60_000)

    it('keeps a read-only path unchangeable inside a writable folder', async () => {
      const { sandboxes, run } = start('readonly', {
        allowWrite: ['~/builds'],
        denyWrite: ['~/builds/release'],
      })
      const out = await run(
        `echo x > ${home}/builds/release/v1 || echo RELEASE-READ-ONLY; echo y > ${home}/builds/dev && echo DEV-OK`,
      )
      sandboxes.stopAll()
      expect(out).toContain('RELEASE-READ-ONLY')
      expect(out).toContain('DEV-OK')
      expect(existsSync(join(home, 'builds/release/v1'))).toBe(false)
    }, 60_000)

    it('hides a path the human listed, inside a readable folder and inside the workspace', async () => {
      const { sandboxes, run } = start('hide', {
        allowRead: ['~/notes'],
        denyRead: ['~/notes/private', join(workDir, 'secrets')],
      })
      const out = await run(
        `cat ${home}/notes/readme.txt; cat ${home}/notes/private/key.txt || echo KEY-HIDDEN; cat ${workDir}/secrets/token.txt || echo TOKEN-HIDDEN`,
      )
      sandboxes.stopAll()
      expect(out).toContain('NOTES-README')
      expect(out).toContain('KEY-HIDDEN')
      expect(out).toContain('TOKEN-HIDDEN')
      expect(out).not.toContain('PRIVATE-KEY')
      expect(out).not.toContain('WORKSPACE-TOKEN')
    }, 60_000)

    it('hides a readable folder again when the same path is on the hidden list', async () => {
      const { sandboxes, run } = start('hide-wins', {
        allowRead: ['~/notes'],
        denyRead: ['~/notes'],
      })
      const out = await run(`cat ${home}/notes/readme.txt || echo NOTES-HIDDEN`)
      sandboxes.stopAll()
      expect(out).toContain('NOTES-HIDDEN')
      expect(out).not.toContain('NOTES-README')
    }, 60_000)

    it('never opens Ostia data, even when the stored settings list it as writable', async () => {
      const { sandboxes, run } = start('guard', { allowRead: [dataDir], allowWrite: [dataDir] })
      const out = await run(
        `cat ${dataDir}/vault.json || echo VAULT-HIDDEN; echo x > ${dataDir}/planted || echo PLANT-REFUSED`,
      )
      sandboxes.stopAll()
      expect(out).toContain('VAULT-HIDDEN')
      expect(out).not.toContain('VAULT-CONTENTS')
      expect(existsSync(join(dataDir, 'planted'))).toBe(false)
    }, 60_000)
  },
)

describe.skipIf(!linux)('sandbox Unix sockets in a real sandbox (Linux only: seccomp)', () => {
  const OPEN_SOCKET =
    'python3 -c "import socket; socket.socket(socket.AF_UNIX); print(\'UNIX-SOCKET-OPENED\')" 2>&1 | tail -1'

  it('lets a sandboxed command open a Unix socket by default', async () => {
    const { sandboxes, run } = start('sockets-on', {})
    const out = await run(OPEN_SOCKET)
    sandboxes.stopAll()
    expect(out).toContain('UNIX-SOCKET-OPENED')
  }, 60_000)

  it('blocks every Unix socket once the human turns them off, and the command still runs', async () => {
    const { sandboxes, run } = start('sockets-off', { switches: { unixSockets: false } })
    const out = await run(`${OPEN_SOCKET}; echo STILL-RUNNING`)
    sandboxes.stopAll()
    expect(out).not.toContain('UNIX-SOCKET-OPENED')
    expect(out).toContain('Operation not permitted')
    expect(out).toContain('STILL-RUNNING')
  }, 60_000)
})

describe.skipIf(!linux)(
  'sandbox violations from a real sandbox (Linux only: bwrap and seccomp observer)',
  () => {
    it('reports a refused connection with its host, port and reason, and offers to allow it', async () => {
      const { sandboxes, run, violations } = start('net', {
        deniedDomains: ['blocked.invalid'],
        switches: { strictDomains: true },
      })
      await run(
        'curl -s -m 5 -o /dev/null http://unlisted.invalid/; curl -s -m 5 -o /dev/null http://blocked.invalid/',
      )
      const list = await violations((v) => v.target === 'blocked.invalid:80')
      sandboxes.stopAll()
      expect(list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'network',
            target: 'unlisted.invalid:80',
            reason: 'not-allowed',
            allowHost: 'unlisted.invalid',
          }),
          expect.objectContaining({
            kind: 'network',
            target: 'blocked.invalid:80',
            reason: 'blocked',
          }),
        ]),
      )
      expect(list.find((v) => v.target === 'blocked.invalid:80')?.allowHost).toBeUndefined()
    }, 60_000)

    it('reports a write outside the writable folders while Unix sockets are off, and not an allowed write', async () => {
      const { sandboxes, run, violations } = start('write-violation', {
        allowWrite: ['~/builds'],
        denyWrite: ['~/builds/release'],
        switches: { unixSockets: false },
      })
      await run(
        `echo ok > ${home}/builds/fine.txt; echo q > /dev/null; echo r > ${home}/builds/release/v2; echo x > /etc/ostia-violation-probe; true`,
      )
      const list = await violations((v) => v.target === '/etc/ostia-violation-probe')
      sandboxes.stopAll()
      expect(list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'write',
            target: '/etc/ostia-violation-probe',
            reason: 'outside',
          }),
        ]),
      )
      expect(list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'write',
            target: join(home, 'builds/release/v2'),
            reason: 'read-only',
          }),
        ]),
      )
      expect(list.some((v) => v.target.includes('fine.txt'))).toBe(false)
      expect(list.some((v) => v.target.startsWith('/dev/'))).toBe(false)
    }, 60_000)

    it('does not report a write to a folder made writable after the sandbox started', async () => {
      const { sandboxes, store, run, violations } = start('late-write', {
        switches: { unixSockets: false },
      })
      await run('true')
      sandboxes.update('ws', (current) => ({ ...current, allowWrite: ['~/builds'] }))
      await sandboxes.refresh('ws')
      await run(`echo late > ${home}/builds/late.txt; echo x > /etc/ostia-late-probe; true`)
      const list = await violations((v) => v.target === '/etc/ostia-late-probe')
      sandboxes.stopAll()
      expect(store.get('ws').allowWrite).toEqual(['~/builds'])
      expect(readFileSync(join(home, 'builds/late.txt'), 'utf8')).toBe('late\n')
      expect(list.some((v) => v.target === '/etc/ostia-late-probe')).toBe(true)
      expect(list.some((v) => v.target.includes('late.txt'))).toBe(false)
    }, 60_000)
  },
)

describe('a workspace folder the sandbox cannot confine', () => {
  it('refuses to wrap a command for a workspace at the home folder and says why in the banner', async () => {
    const { sandboxes } = start('home-folder', {}, home)
    const failure = await sandboxes.wrap('ws', 'bash', 'bash').catch((err: unknown) => err)
    sandboxes.stopAll()
    expect(failure).toBeInstanceOf(SandboxUnavailableError)
    const banner = sandboxFailureBanner((failure as Error).message, [])
    expect(banner).toContain(`${home} is your home folder`)
    expect(banner).toContain('open a project folder instead')
    expect(banner).toContain('No shell was started')
  })

  it('refuses a workspace whose folder is written as ~, instead of handing ~ to the shell as its folder', async () => {
    const { sandboxes } = start('tilde-folder', {}, '~')
    expect(sandboxes.workDir('ws')).toBe(home)
    await expect(sandboxes.wrap('ws', 'bash', 'bash')).rejects.toThrow(
      `${home} is your home folder`,
    )
    sandboxes.stopAll()
  })

  it('refuses a workspace whose folder holds Ostia data', async () => {
    const { sandboxes } = start('data-folder', {}, join(home, '.local'))
    await expect(sandboxes.wrap('ws', 'bash', 'bash')).rejects.toThrow(
      `holds ${PRODUCT_DISPLAY_NAME}'s own data`,
    )
    sandboxes.stopAll()
  })
})
