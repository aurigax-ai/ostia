import { execSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { registerAttentionMethods } from '../main/attention'
import { grant } from '../main/capabilityStore'
import {
  type ControlServerDeps,
  registerControlMethod,
  registerControlServer,
  stopControlServer,
} from '../main/controlServer'
import { type PaneIdentity, registerPane } from '../main/idRegistry'
import { OpenFileGrants } from '../main/openFileGrants'
import { registerOpenFileMethods } from '../main/openFileMethods'
import { registerPaneListMethods } from '../main/paneList'
import { ViewHost, ViewStore } from '../main/viewHost'
import { registerViewMethods } from '../main/viewsIpc'
import { registerWorkflowMethods, workspaceWorkflowsDir } from '../main/workflows'
import { OPEN_FILES_COMMAND } from '../shared/openFiles'
import type { CommandDescriptor, CommandResult, CommandTarget } from '../shared/types'

const repoRoot = process.cwd()
const cliPath = join(repoRoot, 'out', 'cli', 'index.js')

let socketCounter = 0
function nextSocketPath(): string {
  socketCounter += 1
  return join(tmpdir(), `ostia-cli-e2e-${process.pid}-${socketCounter}.sock`)
}

const execCalls: { target: CommandTarget; id: string; args?: unknown }[] = []

const fakeDeps: ControlServerDeps = {
  execCommand: async (target, id, args) => {
    execCalls.push({ target, id, args })
    return { ok: true, result: { ran: id } } as CommandResult
  },
  listCommandsFor: () =>
    [
      {
        id: 'pane.splitRight',
        title: 'Split Right',
        category: null,
        hidden: false,
        argsSchema: null,
        resultSchema: null,
        capabilities: ['drive-self'],
        target: 'active',
      },
      {
        id: 'workspace.describe',
        title: 'Describe Workspace',
        category: 'Workspace',
        hidden: true,
        argsSchema: null,
        resultSchema: null,
        capabilities: ['drive-self'],
        target: 'active',
      },
      {
        id: 'workspace.group',
        title: 'Move Workspace to Group',
        category: 'Workspace',
        hidden: true,
        argsSchema: null,
        resultSchema: null,
        capabilities: ['drive-self'],
        target: 'active',
      },
      {
        id: 'workspace.ungroup',
        title: 'Remove Workspace from Group',
        category: 'Workspace',
        hidden: false,
        argsSchema: null,
        resultSchema: null,
        capabilities: ['drive-self'],
        target: 'active',
      },
    ] as CommandDescriptor[],
  getTerminalState: () => undefined,
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function withEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key]
    else merged[key] = value
  }
  return merged
}

const liveChildren = new Set<ReturnType<typeof spawn>>()

function runOstia(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env, cwd })
    liveChildren.add(child)
    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(
        new Error(
          `ostia ${args.join(' ')} timed out after 10s (stdout=${stdout} stderr=${stderr})`,
        ),
      )
    }, 10_000)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      liveChildren.delete(child)
      reject(err)
    })
    child.on('close', (code) => {
      liveChildren.delete(child)
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

describe('ostia CLI end-to-end (spawns the real out/cli/index.js against a live control server)', () => {
  beforeAll(() => {
    execSync('pnpm run build:cli', { cwd: repoRoot, stdio: 'ignore' })
    registerAttentionMethods({ execCommand: fakeDeps.execCommand })
  }, 60_000)

  let socketPath: string
  let identity: PaneIdentity

  beforeEach(() => {
    socketPath = nextSocketPath()
    identity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pE2E' })
    registerControlServer(fakeDeps, socketPath)
  })

  afterEach(() => {
    stopControlServer()
    execCalls.length = 0
  })

  afterAll(() => {
    for (const child of liveChildren) child.kill('SIGKILL')
    liveChildren.clear()
  })

  it('whoami: prints the minted identity as JSON and exits 0', async () => {
    const res = await runOstia(
      ['whoami'],
      withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token }),
    )

    expect(res.stderr).toBe('')
    expect(res.code).toBe(0)
    const parsed = JSON.parse(res.stdout)
    expect(parsed.externalId).toBe(identity.externalId)
    expect(parsed.paneId).toBe('pE2E')
  })

  it('whoami: reads OSTIA_SOCKET and OSTIA_TOKEN', async () => {
    const res = await runOstia(
      ['whoami'],
      withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token }),
    )

    expect(res.stderr).toBe('')
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout).externalId).toBe(identity.externalId)
  })

  it('commands: lists the descriptors served by the control server and exits 0', async () => {
    const res = await runOstia(
      ['commands'],
      withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token }),
    )

    expect(res.code).toBe(0)
    expect(res.stdout).toContain('pane.splitRight')
    const parsed = JSON.parse(res.stdout) as CommandDescriptor[]
    expect(parsed.some((d) => d.id === 'pane.splitRight')).toBe(true)
  })

  it('pane.splitRight: dispatches command.exec through the real socket and exits 0', async () => {
    const res = await runOstia(
      ['pane.splitRight'],
      withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token }),
    )

    expect(res.code).toBe(0)
    expect(res.stdout).toContain('ok')
    expect(res.stdout).toContain('{"ran":"pane.splitRight"}')
  })

  it('pane.bogus: unknown command id surfaces as a non-zero exit + stderr message', async () => {
    const res = await runOstia(
      ['pane.bogus'],
      withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token }),
    )

    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain("unknown command 'pane.bogus'")
  })

  it('with OSTIA_SOCKET unset: fails fast with a "not inside an Ostia pane" message', async () => {
    const res = await runOstia(
      ['whoami'],
      withEnv({ OSTIA_SOCKET: undefined, OSTIA_TOKEN: undefined }),
    )

    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain('not inside an Ostia pane')
  })

  it('--help / -h print usage without contacting the app', async () => {
    for (const flag of ['--help', '-h']) {
      const res = await runOstia(
        [flag],
        withEnv({ OSTIA_SOCKET: undefined, OSTIA_TOKEN: undefined }),
      )
      expect(res.code).toBe(0)
      expect(res.stdout).toContain('usage: ostia')
    }
  })

  it('stale OSTIA_SOCKET: prints "app not reachable" and exits 1 without a stack trace', async () => {
    const stale = join(tmpdir(), `ostia-cli-e2e-${process.pid}-stale.sock`)
    const res = await runOstia(['whoami'], withEnv({ OSTIA_SOCKET: stale, OSTIA_TOKEN: 'x' }))

    expect(res.code).toBe(1)
    expect(res.stderr.trim()).toBe(`ostia: app not reachable at ${stale}`)
  })

  it('exits 1 with a clear message when the app closes the socket mid-request', async () => {
    const dropPath = nextSocketPath()
    const server = createServer((sock) => sock.once('data', () => sock.destroy()))
    await new Promise<void>((resolve) => server.listen(dropPath, resolve))
    try {
      const res = await runOstia(
        ['bus', 'wait'],
        withEnv({ OSTIA_SOCKET: dropPath, OSTIA_TOKEN: 'x' }),
      )
      expect(res.code).toBe(1)
      expect(res.stderr).toContain('connection to the app closed')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('open with no path: exits 1 with a usage error', async () => {
    const res = await runOstia(
      ['open'],
      withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token }),
    )

    expect(res.code).toBe(1)
    expect(res.stderr).toContain('ostia open: missing <path>')
  })

  it('rejects an unknown flag and a flag without its value before calling the app', async () => {
    const env = withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token })

    const unknown = await runOstia(['vault', 'ls', '--globl'], env)
    expect(unknown.code).toBe(1)
    expect(unknown.stderr.trim()).toBe('ostia: unknown flag --globl')

    const missing = await runOstia(['bus', 'wait', '--timeout'], env)
    expect(missing.code).toBe(1)
    expect(missing.stderr.trim()).toBe('ostia: --timeout needs a value')
  })

  it('rejects a non-numeric numeric flag instead of silently defaulting', async () => {
    const res = await runOstia(
      ['bus', 'wait', '--timeout', 'soon'],
      withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token }),
    )

    expect(res.code).toBe(1)
    expect(res.stderr).toContain("--timeout expects a number, got 'soon'")
  })

  describe('ostia state', () => {
    const env = () => withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token })

    it('sets the attention of the caller own pane with a message', async () => {
      const res = await runOstia(['state', 'waiting', 'approve the migration?'], env())

      expect(res.stderr).toBe('')
      expect(res.code).toBe(0)
      expect(execCalls).toEqual([
        {
          target: { windowId: 'w1', workspaceId: 's1', paneId: 'pE2E' },
          id: 'attention.set',
          args: { state: 'waiting', message: 'approve the migration?' },
        },
      ])
    })

    it('maps clear to none', async () => {
      const res = await runOstia(['state', 'clear'], env())
      expect(res.code).toBe(0)
      expect(execCalls[0]?.args).toEqual({ state: 'none' })
    })

    it('reads the message from a Claude Code hook payload on stdin with -', async () => {
      const child = spawn(process.execPath, [cliPath, 'state', 'waiting', '-'], { env: env() })
      child.stdin.on('error', () => {})
      child.stdin.end(
        JSON.stringify({
          hook_event_name: 'Notification',
          message: 'Claude needs your permission',
        }),
      )
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
      expect(code).toBe(0)
      expect(execCalls[0]?.args).toEqual({
        state: 'waiting',
        message: 'Claude needs your permission',
      })
    })

    it('turns a Claude permission prompt into waiting, and leaves the idle reminder alone', async () => {
      const hook = async (event: string, payload: object): Promise<number | null> => {
        const child = spawn(process.execPath, [cliPath, 'claude-hook', event], { env: env() })
        child.stdin.on('error', () => {})
        child.stdin.end(JSON.stringify(payload))
        return new Promise((resolve) => child.on('close', resolve))
      }
      expect(
        await hook('Notification', {
          notification_type: 'idle_prompt',
          message: 'Claude is waiting for your input',
        }),
      ).toBe(0)
      expect(execCalls).toEqual([])

      expect(
        await hook('Notification', {
          notification_type: 'permission_prompt',
          message: 'Claude needs your permission to use Bash',
        }),
      ).toBe(0)
      expect(execCalls.map((c) => c.args)).toEqual([
        { state: 'waiting', message: 'Claude needs your permission to use Bash' },
      ])
    })

    it('names the tool from a Codex PermissionRequest hook payload on stdin with -', async () => {
      const child = spawn(process.execPath, [cliPath, 'state', 'waiting', '-'], { env: env() })
      child.stdin.on('error', () => {})
      child.stdin.end(
        JSON.stringify({
          session_id: '01a0f04d-431b-7012-9fd4-67cc678354bd',
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'touch x', description: 'probe' },
        }),
      )
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
      expect(code).toBe(0)
      expect(execCalls[0]?.args).toEqual({
        state: 'waiting',
        message: 'Needs your permission to use Bash',
      })
    })

    it('refuses --pane with nothing after it instead of setting the caller pane', async () => {
      const res = await runOstia(['state', 'done', '--pane'], env())
      expect(res.code).toBe(1)
      expect(res.stderr).toContain('ostia: --pane needs a value')
      expect(execCalls).toHaveLength(0)
    })

    it('rejects an unknown state before touching the app', async () => {
      const res = await runOstia(['state', 'sleeping'], env())
      expect(res.code).toBe(1)
      expect(res.stderr).toContain('ostia state: expected one of waiting|done|working|error|clear')
      expect(execCalls).toHaveLength(0)
    })

    it('needs all-workspaces to set another pane, and targets it once granted', async () => {
      const other = registerPane({ windowId: 'w1', workspaceId: 's2', paneId: 'pOther' })
      const denied = await runOstia(['state', 'done', '--pane', other.externalId], env())
      expect(denied.code).toBe(1)
      expect(denied.stderr).toContain('needs-elevation: all-workspaces')
      expect(execCalls).toHaveLength(0)

      grant(identity.externalId, 'all-workspaces')
      const allowed = await runOstia(['state', 'done', '--pane', other.externalId], env())
      expect(allowed.code).toBe(0)
      expect(execCalls[0]?.target).toEqual({ windowId: 'w1', workspaceId: 's2', paneId: 'pOther' })
    })

    it('takes --pane before the state and keeps a message that starts with a dash', async () => {
      grant(identity.externalId, 'all-workspaces')
      const other = registerPane({ windowId: 'w1', workspaceId: 's2', paneId: 'pFlagFirst' })
      const res = await runOstia(
        ['state', '--pane', other.externalId, 'waiting', '- pick a branch'],
        env(),
      )
      expect(res.stderr).toBe('')
      expect(execCalls[0]).toMatchObject({
        target: { paneId: 'pFlagFirst' },
        args: { state: 'waiting', message: '- pick a branch' },
      })
    })
  })

  describe('ostia browse storage', () => {
    const received: unknown[] = []
    beforeAll(() => {
      registerControlMethod('browse.storage', {
        cap: 'browse',
        handler: async (params: unknown) => {
          received.push(params)
          return { ok: true, value: 'v' }
        },
      })
    })

    it('reads the browser sessionStorage area as "session", not a Ostia workspace', async () => {
      grant(identity.externalId, 'browse')
      const res = await runOstia(
        ['browse', 'storage', 'session', 'get', 'token'],
        withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token }),
      )
      expect(res.stderr).toBe('')
      expect(res.code).toBe(0)
      expect(received.at(-1)).toMatchObject({ area: 'session', sub: 'get', key: 'token' })
    })

    it('prints the agent-browser {success, data, error} shape with --json', async () => {
      grant(identity.externalId, 'browse')
      const res = await runOstia(
        ['browse', 'storage', 'local', 'token', '--json'],
        withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token }),
      )
      expect(res.code).toBe(0)
      expect(JSON.parse(res.stdout)).toEqual({ success: true, data: { value: 'v' }, error: null })
    })

    it('reports a usage error as a failed JSON response and exits 1', async () => {
      const res = await runOstia(
        ['browse', '--json', 'storage', 'indexeddb'],
        withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token }),
      )
      expect(res.code).toBe(1)
      const parsed = JSON.parse(res.stdout) as { success: boolean; error: string }
      expect(parsed.success).toBe(false)
      expect(parsed.error).toMatch(/usage: ostia browse storage/)
    })

    it('stores a negative number as the value, not as a flag', async () => {
      grant(identity.externalId, 'browse')
      const res = await runOstia(
        ['browse', 'storage', 'local', 'set', 'offset', '-5'],
        withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token }),
      )
      expect(res.stderr).toBe('')
      expect(res.code).toBe(0)
      expect(received.at(-1)).toEqual({ area: 'local', sub: 'set', key: 'offset', value: '-5' })
    })

    it('runs several commands over one connection with batch', async () => {
      grant(identity.externalId, 'browse')
      const before = received.length
      const res = await runOstia(
        ['browse', 'batch', '--json', 'storage local a', 'storage session "b c"'],
        withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token }),
      )
      expect(res.code).toBe(0)
      const results = JSON.parse(res.stdout) as { command: string[]; success: boolean }[]
      expect(results.map((r) => r.success)).toEqual([true, true])
      expect(results[1].command).toEqual(['storage', 'session', 'b c'])
      expect(received.slice(before)).toEqual([
        { area: 'local', sub: 'get', key: 'a' },
        { area: 'session', sub: 'get', key: 'b c' },
      ])
    })
  })

  describe('ostia workspace describe', () => {
    const env = () => withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token })

    it('sends the text to the caller’s workspace', async () => {
      const res = await runOstia(['workspace', 'describe', 'PR', '#7:', 'fix', 'refunds'], env())
      expect(res.stderr).toBe('')
      expect(res.code).toBe(0)
      expect(execCalls.at(-1)).toMatchObject({
        target: { workspaceId: 's1', paneId: 'pE2E' },
        id: 'workspace.describe',
        args: { text: 'PR #7: fix refunds' },
      })
    })

    it('takes everything after -- as the text, flags included', async () => {
      const res = await runOstia(['workspace', 'describe', '--', '--clear', 'the', 'cache'], env())
      expect(res.code).toBe(0)
      expect(execCalls.at(-1)?.args).toEqual({ text: '--clear the cache' })
    })

    it('clears with --clear and refuses an empty description', async () => {
      expect((await runOstia(['workspace', 'describe', '--clear'], env())).code).toBe(0)
      expect(execCalls.at(-1)?.args).toEqual({ text: '' })
      const empty = await runOstia(['workspace', 'describe'], env())
      expect(empty.code).toBe(1)
      expect(empty.stderr).toContain('missing <text|->')
    })
  })

  describe('ostia workspace groups', () => {
    const env = () => withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token })

    it('moves the caller’s own workspace into a named group', async () => {
      const res = await runOstia(['workspace', 'group', 'code', 'review'], env())
      expect(res.stderr).toBe('')
      expect(res.code).toBe(0)
      expect(execCalls.at(-1)).toMatchObject({
        target: { workspaceId: 's1', paneId: 'pE2E' },
        id: 'workspace.group',
        args: { name: 'code review' },
      })
    })

    it('refuses a missing group name', async () => {
      const res = await runOstia(['workspace', 'group'], env())
      expect(res.code).toBe(1)
      expect(res.stderr).toContain('missing <name>')
      expect(execCalls).toEqual([])
    })

    it('takes the caller’s workspace out of its group', async () => {
      const res = await runOstia(['workspace', 'ungroup'], env())
      expect(res.code).toBe(0)
      expect(execCalls.at(-1)).toMatchObject({
        target: { workspaceId: 's1', paneId: 'pE2E' },
        id: 'workspace.ungroup',
      })
    })

    it('lists workspaces with their groups as JSON and as text', async () => {
      const workspaces = [
        {
          workspaceId: 's1',
          name: 'api',
          kind: 'terminal',
          workDir: '/a',
          state: 'idle',
          groupId: 'g1',
        },
        { workspaceId: 's2', name: 'web', kind: 'terminal', workDir: '/b', state: 'working' },
      ]
      const groups = [{ groupId: 'g1', name: 'backend', collapsed: false, workspaceIds: ['s1'] }]
      registerPaneListMethods({
        execCommand: async (_target, id) =>
          ({ ok: true, result: id === 'workspace.groups' ? groups : workspaces }) as CommandResult,
        getTerminalState: () => undefined,
        ptyPid: () => undefined,
        windowIds: () => ['1'],
      })

      const json = await runOstia(['workspace', 'list', '--json'], env())
      expect(json.stderr).toBe('')
      expect(JSON.parse(json.stdout)).toEqual({ workspaces, groups })

      const text = await runOstia(['workspace', 'list'], env())
      expect(text.stdout.trim().split('\n')).toEqual([
        's1\tbackend\tapi\tidle\t/a',
        's2\t-\tweb\tworking\t/b',
      ])
    })
  })

  describe('ostia workflow', () => {
    const env = () => withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token })
    let dir: string

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'ostia-cli-workflows-'))
      const userDir = join(dir, 'user')
      const workDir = join(dir, 'project')
      mkdirSync(userDir, { recursive: true })
      mkdirSync(workspaceWorkflowsDir(workDir), { recursive: true })
      writeFileSync(
        join(userDir, 'logs.yaml'),
        [
          'name: Follow logs',
          'command: kubectl logs -f deploy/{{app}}',
          'description: Tail a deployment',
          'tags: [k8s]',
          'arguments:',
          '  - name: app',
          '    description: Deployment name',
          '    default_value: api',
          '',
        ].join('\n'),
      )
      writeFileSync(join(userDir, 'broken.yaml'), 'name: nothing to run\n')
      writeFileSync(
        join(workspaceWorkflowsDir(workDir), 'test.yml'),
        'name: Test\ncommand: pnpm test\n',
      )
      registerWorkflowMethods({
        userDir,
        roots: () => [dir],
        workDirForWorkspace: (id) => (id === 's1' ? workDir : undefined),
        extensionWorkflows: () => [
          {
            extId: 'ops',
            workflows: [{ name: 'Deploy', command: 'make deploy', tags: [], arguments: [] }],
          },
        ],
      })
    })

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('lists the caller workspace, user and extension workflows, reporting unreadable files', async () => {
      const res = await runOstia(['workflow', 'list'], env())
      expect(res.code).toBe(0)
      expect(res.stdout.trim().split('\n')).toEqual([
        'Test\tworkspace:test.yml\tpnpm test',
        'Follow logs\tuser:logs.yaml\tkubectl logs -f deploy/{{app}}',
        'Deploy\textension:ops\tmake deploy',
      ])
      expect(res.stderr).toContain("couldn't read user:broken.yaml: missing command")

      const json = await runOstia(['workflow', 'list', '--json'], env())
      const listing = JSON.parse(json.stdout)
      expect(listing.workflows).toHaveLength(3)
      expect(listing.problems).toEqual([
        { source: 'user', origin: 'broken.yaml', error: 'missing command' },
      ])
    })

    it('shows one workflow by name', async () => {
      const res = await runOstia(['workflow', 'show', 'Follow', 'logs'], env())
      expect(res.code).toBe(0)
      expect(res.stdout.trim().split('\n')).toEqual([
        'name: Follow logs',
        'source: user (logs.yaml)',
        'description: Tail a deployment',
        'tags: k8s',
        'command: kubectl logs -f deploy/{{app}}',
        'arguments:',
        '  app — Deployment name (default: api)',
      ])

      const json = await runOstia(['workflow', 'show', 'Deploy', '--json'], env())
      expect(JSON.parse(json.stdout)).toEqual([
        {
          name: 'Deploy',
          command: 'make deploy',
          tags: [],
          arguments: [],
          source: 'extension',
          origin: 'ops',
        },
      ])
    })

    it('fails on an unknown name or a missing subcommand, and has no run verb', async () => {
      const missing = await runOstia(['workflow', 'show', 'Nope'], env())
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain("no workflow named 'Nope'")

      const run = await runOstia(['workflow', 'run', 'Deploy'], env())
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('usage: workflow list')
      expect(execCalls).toEqual([])
    })
  })

  describe('ostia view', () => {
    const env = () => withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token })
    const offline = () => withEnv({ OSTIA_SOCKET: undefined, OSTIA_TOKEN: undefined })
    let dir: string
    let store: ViewStore
    const good = {
      version: 1,
      title: 'Board',
      placement: 'panel',
      root: { type: 'list', for: 'workspaces', item: { type: 'text', text: '{{item.name}}' } },
    }

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'ostia-cli-views-'))
      mkdirSync(join(dir, 'views'))
      writeFileSync(join(dir, 'views', 'board.json'), JSON.stringify(good, null, 2))
      writeFileSync(
        join(dir, 'views', 'side.json'),
        JSON.stringify({ ...good, title: 'Side', placement: 'sidebar' }),
      )
      writeFileSync(
        join(dir, 'bad.json'),
        '{\n  "version": 1,\n  "title": "Bad",\n  "placement": "panel",\n  "root": { "type": "text", "text": "{{env.HOME}}" }\n}\n',
      )
      store = new ViewStore(join(dir, 'views-state.json'))
      const host = new ViewHost({ dir: join(dir, 'views'), store, onChange: () => {} })
      registerViewMethods({ host, execCommand: fakeDeps.execCommand })
    })

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('validates a file without the app and points at the bad line', async () => {
      const ok = await runOstia(['view', 'validate', join(dir, 'views', 'board.json')], offline())
      expect(ok.code).toBe(0)
      expect(ok.stdout.trim()).toBe('ok: "Board" (panel), data: workspaces')

      const bad = await runOstia(['view', 'validate', join(dir, 'bad.json')], offline())
      expect(bad.code).toBe(1)
      expect(bad.stderr.trim()).toBe(
        `${join(dir, 'bad.json')}:5: root.text: unknown data source 'env' (known here: workspace, workspaces, panes, ports, approvals, notifications, clock)`,
      )
    })

    it('prints the JSON schema without the app', async () => {
      const res = await runOstia(['view', 'schema'], offline())
      expect(res.code).toBe(0)
      const schema = JSON.parse(res.stdout)
      expect(schema.required).toEqual(['version', 'title', 'placement', 'root'])
    })

    it('lists views with their status and opens only an enabled panel view', async () => {
      const list = await runOstia(['view', 'list'], env())
      expect(list.code).toBe(0)
      expect(list.stdout.trim().split('\n').slice(1)).toEqual([
        'board\tpending\tpanel\tBoard',
        'side\tpending\tsidebar\tSide',
      ])

      const pending = await runOstia(['view', 'open', 'board'], env())
      expect(pending.code).toBe(1)
      expect(pending.stderr).toContain('has not enabled this view')
      expect(execCalls).toEqual([])

      store.set('board', { enabled: true })
      store.set('side', { enabled: true })
      const opened = await runOstia(['view', 'open', 'board'], env())
      expect(opened.code).toBe(0)
      expect(execCalls).toEqual([
        {
          target: { windowId: 'w1', workspaceId: 's1', paneId: 'pE2E' },
          id: 'views.open',
          args: { name: 'board' },
        },
      ])

      const sidebar = await runOstia(['view', 'open', 'side'], env())
      expect(sidebar.code).toBe(1)
      expect(sidebar.stderr).toContain('only placement "panel" views open as a pane')
    })
  })

  describe('ostia <file>', () => {
    let base: string
    let home: string
    let outside: string
    const sandboxed = new Set<string>()
    const env = () => withEnv({ OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token })
    const opened = () => execCalls.filter((c) => c.id === OPEN_FILES_COMMAND).map((c) => c.args)

    beforeAll(() => {
      base = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-cli-open-')))
      home = join(base, 'home')
      outside = join(base, 'outside')
      mkdirSync(join(home, 'git'), { recursive: true })
      mkdirSync(outside)
      writeFileSync(join(home, 'README'), 'readme')
      writeFileSync(join(home, 'echo'), 'a file named like an extension')
      writeFileSync(join(home, 'pane.splitRight'), 'a file named like a command')
      writeFileSync(join(home, 'state'), 'a file named like a verb')
      writeFileSync(join(outside, 'app.log'), 'one\ntwo\nthree\n')
      writeFileSync(join(outside, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      registerOpenFileMethods({
        grants: new OpenFileGrants({ roots: () => [home], file: join(base, 'opened-files.json') }),
        isSandboxed: (workspaceId) => sandboxed.has(workspaceId),
        isScratch: () => false,
        execCommand: fakeDeps.execCommand,
      })
      registerControlMethod('ext.list', {
        handler: () => [{ id: 'echo', name: 'Echo', status: 'running', commands: [] }],
      })
    })

    afterEach(() => sandboxed.clear())

    afterAll(() => rmSync(base, { recursive: true, force: true }))

    it('opens files anywhere on disk, each as its own target, in the caller pane', async () => {
      const res = await runOstia([join(outside, 'app.log'), join(outside, 'shot.png')], env())

      expect(res.stderr).toBe('')
      expect(res.code).toBe(0)
      expect(execCalls).toEqual([
        {
          target: { windowId: 'w1', workspaceId: 's1', paneId: 'pE2E' },
          id: OPEN_FILES_COMMAND,
          args: {
            files: [{ path: join(outside, 'app.log') }, { path: join(outside, 'shot.png') }],
          },
        },
      ])
    })

    it('resolves a relative path against the caller folder and reads file:line:col', async () => {
      const res = await runOstia(['../outside/app.log:2:3'], env(), home)

      expect(res.code).toBe(0)
      expect(opened()).toEqual([
        { files: [{ path: join(outside, 'app.log'), line: 2, column: 3 }] },
      ])
    })

    it('opens a bare name that is a file here and neither a verb nor an extension', async () => {
      const res = await runOstia(['README'], env(), home)

      expect(res.code).toBe(0)
      expect(opened()).toEqual([{ files: [{ path: join(home, 'README') }] }])
    })

    it('lets a core verb, an extension id and a command id win over a file of that name', async () => {
      const verb = await runOstia(['state', 'done'], env(), home)
      expect(verb.code).toBe(0)
      expect(execCalls.map((c) => c.id)).toEqual(['attention.set'])
      execCalls.length = 0

      const extension = await runOstia(['echo', 'hi'], env(), home)
      expect(extension.stderr).toContain("ostia echo: unknown subcommand 'hi'")

      const command = await runOstia(['pane.splitRight'], env(), home)
      expect(command.stdout).toContain('{"ran":"pane.splitRight"}')

      const folder = await runOstia(['git', 'status'], env(), home)
      expect(folder.stderr).toContain("unknown command or extension 'git'")
      expect(opened()).toEqual([])
    })

    it('ostia open takes several files and still opens the ones it can', async () => {
      const res = await runOstia(
        ['open', join(outside, 'app.log'), outside, join(outside, 'nope.txt')],
        env(),
      )

      expect(res.code).toBe(1)
      expect(res.stderr).toContain(`ostia: ${outside}: is a directory`)
      expect(res.stderr).toContain(`ostia: ${join(outside, 'nope.txt')}: no such file`)
      expect(opened()).toEqual([{ files: [{ path: join(outside, 'app.log') }] }])
    })

    it('refuses a sandboxed workspace a file outside the home folder', async () => {
      sandboxed.add('s1')
      const res = await runOstia([join(outside, 'shot.png'), join(home, 'README')], env())

      expect(res.code).toBe(1)
      expect(res.stderr).toContain('outside what a sandboxed workspace may open')
      expect(opened()).toEqual([{ files: [{ path: join(home, 'README') }] }])
    })

    it('outside Ostia: a file path does not start the manager', async () => {
      const res = await runOstia(
        [join(outside, 'app.log')],
        withEnv({ OSTIA_SOCKET: undefined, OSTIA_TOKEN: undefined }),
      )

      expect(res.code).toBe(1)
      expect(res.stderr).toContain('files open from a terminal inside Ostia')
    })
  })
})
