import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SANDBOX_GLOBALS } from '../../shared/sandbox/sandbox'
import { quoteArgv } from '../../shared/terminal/shellQuote'
import { shellArgv } from '../../shared/terminal/terminalShell'
import { availableReadPresets } from './presets'
import { sandboxedShellCommand, wrapForTerminal } from './ptyWrap'
import { hiddenHomeNotice, sandboxFailureBanner } from './spawnBanner'
import { sandboxSpawnEnv } from './spawnEnv'
import { SandboxStore } from './store'
import { ViolationLog, recordViolations } from './violations'
import { SandboxUnavailableError, WorkspaceSandboxes } from './workspaceSandboxes'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-ws.mjs')

let root: string
let workDir: string
let storePath: string
let noBwrapPath: string

function sandboxes(store: SandboxStore, env?: NodeJS.ProcessEnv): WorkspaceSandboxes {
  return new WorkspaceSandboxes({
    store,
    globals: () => DEFAULT_SANDBOX_GLOBALS,
    basePaths: () => ({
      home: join(root, 'home'),
      dataDirs: [],
      socketPath: join(root, 'ostia.sock'),
      runtimeReads: [],
    }),
    workDir: () => workDir,
    tmpRoot: join(root, 'tmp'),
    nodePath: process.execPath,
    hostScript,
    hostEnv: env,
    onAsk: async () => false,
  })
}

async function shellIn(manager: WorkspaceSandboxes, ws: string, script: string): Promise<string> {
  const wrapped = await manager.wrap(ws, `{ ${script}; } 2>&1; true`, 'bash')
  return execFileSync('/bin/sh', ['-c', wrapped], {
    cwd: workDir,
    encoding: 'utf8',
    env: { ...process.env, HOME: join(root, 'home') },
  })
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-wsbx-')))
  workDir = join(root, 'home', 'proj')
  mkdirSync(workDir, { recursive: true })
  storePath = join(root, 'sandbox.json')
  noBwrapPath = join(root, 'bin')
  mkdirSync(noBwrapPath)
  for (const tool of ['rg', 'socat', 'sh', 'bash', 'which']) {
    symlinkSync(`/usr/bin/${tool}`, join(noBwrapPath, tool))
  }
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceSandboxes', () => {
  it.skipIf(process.platform === 'darwin')(
    'SBX-C9 fails closed and names bubblewrap when bwrap is missing (Linux only: bubblewrap)',
    async () => {
      const store = new SandboxStore(join(root, 'c9.json'))
      store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {} })
      const manager = sandboxes(store, { ...process.env, PATH: noBwrapPath })
      const failure = await manager.wrap('ws', 'bash', 'bash').catch((err: unknown) => err)
      expect(failure).toBeInstanceOf(SandboxUnavailableError)
      const { message, missing } = failure as SandboxUnavailableError
      const banner = sandboxFailureBanner(message, missing)
      expect(banner).toContain('bubblewrap')
      expect(banner).toContain('ostia system install bubblewrap')
      expect(banner).not.toContain('socat')
      manager.stopAll()
    },
  )

  it.skipIf(process.platform === 'darwin')(
    'SBX-C11 starts sandboxed once the missing package is there, after a failed attempt (Linux only: bubblewrap)',
    async () => {
      const store = new SandboxStore(join(root, 'c11.json'))
      store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {} })
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: noBwrapPath }
      const manager = sandboxes(store, env)
      await expect(manager.wrap('ws', 'bash', 'bash')).rejects.toBeInstanceOf(
        SandboxUnavailableError,
      )
      env.PATH = process.env.PATH
      const wrapped = await manager.wrap('ws', 'bash', 'bash')
      expect(wrapped).toContain('bwrap')
      manager.stopAll()
    },
    30_000,
  )

  it('SBX-C12 keeps a sandboxed workspace and its stored domains across a restart, but not grants until restart', async () => {
    const first = new SandboxStore(storePath)
    first.set('ws', { enabled: true, allowRead: [], domains: ['example.com'], controls: {} })
    const before = sandboxes(first)
    before.allowUntilRestart('ws', 'session-only.example.org')
    expect(before.config('ws').network.allowedDomains).toContain('session-only.example.org')
    const after = sandboxes(new SandboxStore(storePath))
    expect(after.isEnabled('ws')).toBe(true)
    const domains = after.config('ws').network.allowedDomains
    expect(domains).toContain('example.com')
    expect(domains).not.toContain('session-only.example.org')
  })

  it('SBX-C15 reports a corrupt sandbox file and fails every sandboxed spawn closed', async () => {
    const path = join(root, 'corrupt.json')
    writeFileSync(path, '{ not json')
    const store = new SandboxStore(path)
    expect(store.isCorrupt).toBe(true)
    const manager = sandboxes(store)
    expect(manager.isEnabled('any-workspace')).toBe(true)
    await expect(manager.wrap('any-workspace', 'bash', 'bash')).rejects.toThrow(/unreadable/)
    store.set('any-workspace', { enabled: false, allowRead: [], domains: [], controls: {} })
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
  })

  it('SBX-C17 removes the workspace entry and its tmp dir when the workspace closes', () => {
    const path = join(root, 'c17.json')
    const store = new SandboxStore(path)
    store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {} })
    const manager = sandboxes(store)
    manager.config('ws')
    expect(existsSync(manager.tmpDir('ws'))).toBe(true)
    manager.forget('ws')
    expect(new SandboxStore(path).has('ws')).toBe(false)
    expect(existsSync(manager.tmpDir('ws'))).toBe(false)
  })

  it('SBX-C25 lets a shell read a path the human added to its workspace, and not other workspaces', async () => {
    const notes = join(root, 'home', 'notes')
    mkdirSync(notes, { recursive: true })
    writeFileSync(join(notes, 'n.txt'), 'NOTE-CONTENT')
    const store = new SandboxStore(join(root, 'c25.json'))
    store.set('a', { enabled: true, allowRead: ['~/notes'], domains: [], controls: {} })
    store.set('b', { enabled: true, allowRead: [], domains: [], controls: {} })
    const readIn = async (manager: WorkspaceSandboxes, ws: string): Promise<string> => {
      const wrapped = await manager.wrap(ws, `cat ${join(notes, 'n.txt')} 2>&1; true`, 'bash')
      return execFileSync('/bin/sh', ['-c', wrapped], { cwd: workDir, encoding: 'utf8' })
    }
    const managerA = sandboxes(store)
    const managerB = sandboxes(store)
    expect(await readIn(managerA, 'a')).toContain('NOTE-CONTENT')
    const inB = await readIn(managerB, 'b')
    expect(inB).not.toContain('NOTE-CONTENT')
    expect(inB).toContain(
      process.platform === 'darwin' ? 'Operation not permitted' : 'No such file or directory',
    )
    managerA.stopAll()
    managerB.stopAll()
  }, 30_000)

  it('a sandboxed workspace wraps the shell chosen in terminal.shell', async () => {
    const store = new SandboxStore(join(root, 'shell.json'))
    store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {} })
    const manager = sandboxes(store)
    const shell = quoteArgv(shellArgv('/bin/sh -i', '/bin/false'))
    const wrapped = await manager.wrap('ws', sandboxedShellCommand(shell, undefined, null), 'bash')
    const out = execFileSync('/bin/sh', ['-c', wrapForTerminal(wrapped, null)], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: 'pipe',
      input: 'echo "sandbox=${HTTPS_PROXY:+on} flags=$-"\nexit\n',
    })
    expect(out).toMatch(/sandbox=on flags=\S*i/)
    manager.stopAll()
  }, 30_000)

  it('SBX-C56 keeps an inherited ssh-agent socket out of reach and out of the environment', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'ostia-c56-agent-'))
    const agentSock = join(agentDir, 'agent.sock')
    const server = createServer((socket) => socket.end('AGENT-REACHED'))
    await new Promise<void>((resolve) => server.listen(agentSock, resolve))
    try {
      const env = sandboxSpawnEnv({ PATH: '/usr/bin', SSH_AUTH_SOCK: agentSock, KEEP: '1' })
      expect(env).toEqual({ PATH: '/usr/bin', KEEP: '1' })
      const store = new SandboxStore(join(root, 'c56.json'))
      store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {} })
      const manager = new WorkspaceSandboxes({
        store,
        globals: () => DEFAULT_SANDBOX_GLOBALS,
        basePaths: () => ({
          home: join(root, 'home'),
          dataDirs: [],
          socketPath: join(root, 'ostia.sock'),
          runtimeReads: [],
          agentSockets: [agentSock],
        }),
        workDir: () => workDir,
        tmpRoot: join(root, 'tmp'),
        nodePath: process.execPath,
        hostScript,
        onAsk: async () => false,
      })
      const probe = `node -e "require('net').connect('${agentSock}').on('data',d=>console.log(String(d))).on('error',e=>console.log('ERR',e.code))"`
      const wrapped = await manager.wrap('ws', probe, 'bash')
      const out = execFileSync('/bin/sh', ['-c', wrapped], { cwd: workDir, encoding: 'utf8' })
      expect(out).not.toContain('AGENT-REACHED')
      manager.stopAll()
    } finally {
      server.close()
      rmSync(agentDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('SBX-C5 a workspace with the sandbox off spawns an unwrapped shell', () => {
    const manager = sandboxes(new SandboxStore(join(root, 'c5.json')))
    expect(manager.isEnabled('ws')).toBe(false)
    expect(manager.settings('ws').enabled).toBe(false)
  })

  it('SBX-C6 turning the sandbox on asks running panes to restart, and the restart sandboxes them', async () => {
    const home = join(root, 'home')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'SECRET-KEY-MATERIAL')
    const manager = sandboxes(new SandboxStore(join(root, 'c6.json')))
    expect(manager.isEnabled('ws')).toBe(false)
    manager.update('ws', (current) => ({ ...current, enabled: true }))
    expect(manager.isEnabled('ws')).toBe(true)
    const out = await shellIn(
      manager,
      'ws',
      `cat ${home}/.ssh/id_ed25519 || echo C6-DENIED; echo proxy=\${HTTPS_PROXY:+on}`,
    )
    expect(out).toContain('C6-DENIED')
    expect(out).toContain('proxy=on')
    expect(out).not.toContain('SECRET-KEY-MATERIAL')
    manager.stopAll()
  }, 30_000)

  it('a folder added as writable in Settings can be written from the sandbox once the shell restarts', async () => {
    const builds = join(root, 'home', 'builds')
    mkdirSync(builds, { recursive: true })
    const store = new SandboxStore(join(root, 'writable.json'))
    store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {} })
    const manager = sandboxes(store)
    expect(await shellIn(manager, 'ws', `echo early > ${builds}/early.txt; echo BEFORE`)).toContain(
      'BEFORE',
    )
    expect(existsSync(join(builds, 'early.txt'))).toBe(false)
    manager.update('ws', (current) => ({ ...current, allowWrite: ['~/builds'] }))
    await manager.refresh('ws')
    expect(await shellIn(manager, 'ws', `echo built > ${builds}/out.txt && echo AFTER`)).toContain(
      'AFTER',
    )
    expect(readFileSync(join(builds, 'out.txt'), 'utf8')).toBe('built\n')
    manager.stopAll()
  }, 30_000)

  it('a tool-folder preset switched on in Settings makes the tool readable once the shell restarts', async () => {
    const bun = join(root, 'home', '.bun', 'bin', 'bun')
    mkdirSync(join(root, 'home', '.bun', 'bin'), { recursive: true })
    writeFileSync(bun, 'BUN-BINARY-STANDIN')
    const store = new SandboxStore(join(root, 'preset.json'))
    store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {} })
    const manager = sandboxes(store)
    const before = await shellIn(manager, 'ws', `cat ${bun}; echo BEFORE`)
    expect(before).toContain('BEFORE')
    expect(before).not.toContain('BUN-BINARY-STANDIN')
    const presets = availableReadPresets(manager.pathEnv(), {})
    expect(presets.map((preset) => preset.id)).not.toContain('deno')
    const paths = presets.find((preset) => preset.id === 'bun')?.paths ?? []
    expect(paths).toEqual(['~/.bun'])
    manager.update('ws', (current) => ({ ...current, allowRead: [...current.allowRead, ...paths] }))
    await manager.refresh('ws')
    expect(await shellIn(manager, 'ws', `cat ${bun}; echo AFTER`)).toContain('BUN-BINARY-STANDIN')
    manager.stopAll()
  }, 30_000)

  it('a path hidden in Settings cannot be read from the sandbox, even inside the workspace folder', async () => {
    mkdirSync(join(workDir, 'secrets'), { recursive: true })
    writeFileSync(join(workDir, 'secrets', 'token.txt'), 'WORKSPACE-TOKEN-VALUE')
    const store = new SandboxStore(join(root, 'hidden.json'))
    store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {} })
    const manager = sandboxes(store)
    expect(await shellIn(manager, 'ws', 'cat secrets/token.txt')).toContain('WORKSPACE-TOKEN-VALUE')
    manager.update('ws', (current) => ({ ...current, denyRead: [join(workDir, 'secrets')] }))
    await manager.refresh('ws')
    const after = await shellIn(manager, 'ws', 'cat secrets/token.txt || echo HIDDEN')
    expect(after).toContain('HIDDEN')
    expect(after).not.toContain('WORKSPACE-TOKEN-VALUE')
    manager.stopAll()
  }, 30_000)

  it('a refused connection shows up under Blocked with its host, and Clear empties the list', async () => {
    const store = new SandboxStore(join(root, 'blocked.json'))
    store.set('ws', {
      enabled: true,
      allowRead: [],
      domains: [],
      controls: {},
      switches: { strictDomains: true },
    })
    const log = new ViolationLog()
    const asked: string[] = []
    const manager: WorkspaceSandboxes = new WorkspaceSandboxes({
      store,
      globals: () => DEFAULT_SANDBOX_GLOBALS,
      basePaths: () => ({
        home: join(root, 'home'),
        dataDirs: [],
        socketPath: join(root, 'ostia.sock'),
        runtimeReads: [],
      }),
      workDir: () => workDir,
      tmpRoot: join(root, 'tmp'),
      nodePath: process.execPath,
      hostScript,
      onAsk: async (_ws, host) => {
        asked.push(host)
        return false
      },
      onViolations: (ws, lines) =>
        recordViolations(log, (path) => manager.writeRefusal(ws, path), ws, lines),
    })
    const out = await shellIn(
      manager,
      'ws',
      'curl -s -m 10 -o /dev/null http://unlisted.invalid/; echo CURL-DONE',
    )
    expect(out).toContain('CURL-DONE')
    await expect
      .poll(() => log.list('ws').map((row) => row.target), { timeout: 10_000 })
      .toContain('unlisted.invalid:80')
    expect(log.list('ws').find((row) => row.target === 'unlisted.invalid:80')).toMatchObject({
      kind: 'network',
      reason: 'not-allowed',
      allowHost: 'unlisted.invalid',
    })
    expect(asked).toEqual([])
    log.clear('ws')
    expect(log.list('ws')).toEqual([])
    manager.stopAll()
  }, 30_000)

  it.skipIf(process.platform !== 'linux')(
    'tells a sandboxed shell that its home folder is hidden and that files written there are discarded',
    async () => {
      const store = new SandboxStore(join(root, 'home-notice.json'))
      store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {} })
      const manager = sandboxes(store)
      expect(manager.claimHomeNotice('ws')).toBe(true)
      expect(manager.claimHomeNotice('ws')).toBe(false)
      expect(hiddenHomeNotice()).toContain('your home folder is hidden here')
      expect(hiddenHomeNotice()).toContain('are discarded when this shell exits')
      const home = join(root, 'home')
      const out = await shellIn(
        manager,
        'ws',
        `echo kept > ${home}/lost.txt && cat ${home}/lost.txt && echo WROTE`,
      )
      expect(out).toContain('WROTE')
      expect(existsSync(join(home, 'lost.txt'))).toBe(false)
      manager.stopAll()
    },
    30_000,
  )
})
