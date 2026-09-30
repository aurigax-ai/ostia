import { execSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { registerPaneListMethods } from '../main/paneList'
import { ViewHost, ViewStore } from '../main/viewHost'
import { registerViewMethods } from '../main/viewsIpc'
import { registerWorkflowMethods, workspaceWorkflowsDir } from '../main/workflows'
import type { CommandDescriptor, CommandResult, CommandTarget } from '../shared/types'

const repoRoot = process.cwd()
const cliPath = join(repoRoot, 'out', 'cli', 'index.js')

let socketCounter = 0
function nextSocketPath(): string {
  socketCounter += 1
  return join(tmpdir(), `pine-cli-e2e-${process.pid}-${socketCounter}.sock`)
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

function runPine(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env })
    liveChildren.add(child)
    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(
        new Error(`pine ${args.join(' ')} timed out after 10s (stdout=${stdout} stderr=${stderr})`),
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

describe('pine CLI end-to-end (spawns the real out/cli/index.js against a live control server)', () => {
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
    const res = await runPine(
      ['whoami'],
      withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
    )

    expect(res.stderr).toBe('')
    expect(res.code).toBe(0)
    const parsed = JSON.parse(res.stdout)
    expect(parsed.externalId).toBe(identity.externalId)
    expect(parsed.paneId).toBe('pE2E')
  })

  it('commands: lists the descriptors served by the control server and exits 0', async () => {
    const res = await runPine(
      ['commands'],
      withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
    )

    expect(res.code).toBe(0)
    expect(res.stdout).toContain('pane.splitRight')
    const parsed = JSON.parse(res.stdout) as CommandDescriptor[]
    expect(parsed.some((d) => d.id === 'pane.splitRight')).toBe(true)
  })

  it('pane.splitRight: dispatches command.exec through the real socket and exits 0', async () => {
    const res = await runPine(
      ['pane.splitRight'],
      withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
    )

    expect(res.code).toBe(0)
    expect(res.stdout).toContain('ok')
    expect(res.stdout).toContain('{"ran":"pane.splitRight"}')
  })

  it('pane.bogus: unknown command id surfaces as a non-zero exit + stderr message', async () => {
    const res = await runPine(
      ['pane.bogus'],
      withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
    )

    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain("unknown command 'pane.bogus'")
  })

  it('with PINE_SOCKET unset: fails fast with a "not inside a Pine pane" message', async () => {
    const res = await runPine(
      ['whoami'],
      withEnv({ PINE_SOCKET: undefined, PINE_TOKEN: undefined }),
    )

    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain('not inside a Pine pane')
  })

  it('--help / -h print usage without contacting the app', async () => {
    for (const flag of ['--help', '-h']) {
      const res = await runPine([flag], withEnv({ PINE_SOCKET: undefined, PINE_TOKEN: undefined }))
      expect(res.code).toBe(0)
      expect(res.stdout).toContain('usage: pine')
    }
  })

  it('stale PINE_SOCKET: prints "app not reachable" and exits 1 without a stack trace', async () => {
    const stale = join(tmpdir(), `pine-cli-e2e-${process.pid}-stale.sock`)
    const res = await runPine(['whoami'], withEnv({ PINE_SOCKET: stale, PINE_TOKEN: 'x' }))

    expect(res.code).toBe(1)
    expect(res.stderr.trim()).toBe(`pine: app not reachable at ${stale}`)
  })

  it('exits 1 with a clear message when the app closes the socket mid-request', async () => {
    const dropPath = nextSocketPath()
    const server = createServer((sock) => sock.once('data', () => sock.destroy()))
    await new Promise<void>((resolve) => server.listen(dropPath, resolve))
    try {
      const res = await runPine(
        ['bus', 'wait'],
        withEnv({ PINE_SOCKET: dropPath, PINE_TOKEN: 'x' }),
      )
      expect(res.code).toBe(1)
      expect(res.stderr).toContain('connection to the app closed')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('open with no path: exits 1 with a usage error', async () => {
    const res = await runPine(
      ['open'],
      withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
    )

    expect(res.code).toBe(1)
    expect(res.stderr).toContain('pine open: missing <path>')
  })

  it('rejects a non-numeric numeric flag instead of silently defaulting', async () => {
    const res = await runPine(
      ['bus', 'wait', '--timeout', 'soon'],
      withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
    )

    expect(res.code).toBe(1)
    expect(res.stderr).toContain("--timeout expects a number, got 'soon'")
  })

  describe('pine state', () => {
    const env = () => withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token })

    it('sets the attention of the caller own pane with a message', async () => {
      const res = await runPine(['state', 'waiting', 'approve the migration?'], env())

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
      const res = await runPine(['state', 'clear'], env())
      expect(res.code).toBe(0)
      expect(execCalls[0]?.args).toEqual({ state: 'none' })
    })

    it('reads the message from a Claude Code hook payload on stdin with -', async () => {
      const child = spawn(process.execPath, [cliPath, 'state', 'waiting', '-'], { env: env() })
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

    it('names the tool from a Codex PermissionRequest hook payload on stdin with -', async () => {
      const child = spawn(process.execPath, [cliPath, 'state', 'waiting', '-'], { env: env() })
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

    it('rejects an unknown state before touching the app', async () => {
      const res = await runPine(['state', 'sleeping'], env())
      expect(res.code).toBe(1)
      expect(res.stderr).toContain('pine state: expected one of waiting|done|working|error|clear')
      expect(execCalls).toHaveLength(0)
    })

    it('needs all-workspaces to set another pane, and targets it once granted', async () => {
      const other = registerPane({ windowId: 'w1', workspaceId: 's2', paneId: 'pOther' })
      const denied = await runPine(['state', 'done', '--pane', other.externalId], env())
      expect(denied.code).toBe(1)
      expect(denied.stderr).toContain('needs-elevation: all-workspaces')
      expect(execCalls).toHaveLength(0)

      grant(identity.externalId, 'all-workspaces')
      const allowed = await runPine(['state', 'done', '--pane', other.externalId], env())
      expect(allowed.code).toBe(0)
      expect(execCalls[0]?.target).toEqual({ windowId: 'w1', workspaceId: 's2', paneId: 'pOther' })
    })
  })

  describe('pine browse storage', () => {
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

    it('reads the browser sessionStorage area as "session", not a Pine workspace', async () => {
      grant(identity.externalId, 'browse')
      const res = await runPine(
        ['browse', 'storage', 'session', 'get', 'token'],
        withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
      )
      expect(res.stderr).toBe('')
      expect(res.code).toBe(0)
      expect(received.at(-1)).toMatchObject({ area: 'session', sub: 'get', key: 'token' })
    })

    it('prints the agent-browser {success, data, error} shape with --json', async () => {
      grant(identity.externalId, 'browse')
      const res = await runPine(
        ['browse', 'storage', 'local', 'token', '--json'],
        withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
      )
      expect(res.code).toBe(0)
      expect(JSON.parse(res.stdout)).toEqual({ success: true, data: { value: 'v' }, error: null })
    })

    it('reports a usage error as a failed JSON response and exits 1', async () => {
      const res = await runPine(
        ['browse', '--json', 'storage', 'indexeddb'],
        withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
      )
      expect(res.code).toBe(1)
      const parsed = JSON.parse(res.stdout) as { success: boolean; error: string }
      expect(parsed.success).toBe(false)
      expect(parsed.error).toMatch(/usage: pine browse storage/)
    })

    it('runs several commands over one connection with batch', async () => {
      grant(identity.externalId, 'browse')
      const before = received.length
      const res = await runPine(
        ['browse', 'batch', '--json', 'storage local a', 'storage session "b c"'],
        withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
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

  describe('pine workspace describe', () => {
    const env = () => withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token })

    it('sends the text to the caller’s workspace', async () => {
      const res = await runPine(['workspace', 'describe', 'PR', '#7:', 'fix', 'refunds'], env())
      expect(res.stderr).toBe('')
      expect(res.code).toBe(0)
      expect(execCalls.at(-1)).toMatchObject({
        target: { workspaceId: 's1', paneId: 'pE2E' },
        id: 'workspace.describe',
        args: { text: 'PR #7: fix refunds' },
      })
    })

    it('clears with --clear and refuses an empty description', async () => {
      expect((await runPine(['workspace', 'describe', '--clear'], env())).code).toBe(0)
      expect(execCalls.at(-1)?.args).toEqual({ text: '' })
      const empty = await runPine(['workspace', 'describe'], env())
      expect(empty.code).toBe(1)
      expect(empty.stderr).toContain('missing <text|->')
    })
  })

  describe('pine workspace groups', () => {
    const env = () => withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token })

    it('moves the caller’s own workspace into a named group', async () => {
      const res = await runPine(['workspace', 'group', 'code', 'review'], env())
      expect(res.stderr).toBe('')
      expect(res.code).toBe(0)
      expect(execCalls.at(-1)).toMatchObject({
        target: { workspaceId: 's1', paneId: 'pE2E' },
        id: 'workspace.group',
        args: { name: 'code review' },
      })
    })

    it('refuses a missing group name', async () => {
      const res = await runPine(['workspace', 'group'], env())
      expect(res.code).toBe(1)
      expect(res.stderr).toContain('missing <name>')
      expect(execCalls).toEqual([])
    })

    it('takes the caller’s workspace out of its group', async () => {
      const res = await runPine(['workspace', 'ungroup'], env())
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
      })

      const json = await runPine(['workspace', 'list', '--json'], env())
      expect(json.stderr).toBe('')
      expect(JSON.parse(json.stdout)).toEqual({ workspaces, groups })

      const text = await runPine(['workspace', 'list'], env())
      expect(text.stdout.trim().split('\n')).toEqual([
        's1\tbackend\tapi\tidle\t/a',
        's2\t-\tweb\tworking\t/b',
      ])
    })
  })

  describe('pine workflow', () => {
    const env = () => withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token })
    let dir: string

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'pine-cli-workflows-'))
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
      const res = await runPine(['workflow', 'list'], env())
      expect(res.code).toBe(0)
      expect(res.stdout.trim().split('\n')).toEqual([
        'Test\tworkspace:test.yml\tpnpm test',
        'Follow logs\tuser:logs.yaml\tkubectl logs -f deploy/{{app}}',
        'Deploy\textension:ops\tmake deploy',
      ])
      expect(res.stderr).toContain("couldn't read user:broken.yaml: missing command")

      const json = await runPine(['workflow', 'list', '--json'], env())
      const listing = JSON.parse(json.stdout)
      expect(listing.workflows).toHaveLength(3)
      expect(listing.problems).toEqual([
        { source: 'user', origin: 'broken.yaml', error: 'missing command' },
      ])
    })

    it('shows one workflow by name', async () => {
      const res = await runPine(['workflow', 'show', 'Follow', 'logs'], env())
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

      const json = await runPine(['workflow', 'show', 'Deploy', '--json'], env())
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
      const missing = await runPine(['workflow', 'show', 'Nope'], env())
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain("no workflow named 'Nope'")

      const run = await runPine(['workflow', 'run', 'Deploy'], env())
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('usage: workflow list')
      expect(execCalls).toEqual([])
    })
  })

  describe('pine view', () => {
    const env = () => withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token })
    const offline = () => withEnv({ PINE_SOCKET: undefined, PINE_TOKEN: undefined })
    let dir: string
    let store: ViewStore
    const good = {
      version: 1,
      title: 'Board',
      placement: 'panel',
      root: { type: 'list', for: 'workspaces', item: { type: 'text', text: '{{item.name}}' } },
    }

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'pine-cli-views-'))
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
      const ok = await runPine(['view', 'validate', join(dir, 'views', 'board.json')], offline())
      expect(ok.code).toBe(0)
      expect(ok.stdout.trim()).toBe('ok: "Board" (panel), data: workspaces')

      const bad = await runPine(['view', 'validate', join(dir, 'bad.json')], offline())
      expect(bad.code).toBe(1)
      expect(bad.stderr.trim()).toBe(
        `${join(dir, 'bad.json')}:5: root.text: unknown data source 'env' (known here: workspace, workspaces, panes, ports, approvals, notifications, clock)`,
      )
    })

    it('prints the JSON schema without the app', async () => {
      const res = await runPine(['view', 'schema'], offline())
      expect(res.code).toBe(0)
      const schema = JSON.parse(res.stdout)
      expect(schema.required).toEqual(['version', 'title', 'placement', 'root'])
    })

    it('lists views with their status and opens only an enabled panel view', async () => {
      const list = await runPine(['view', 'list'], env())
      expect(list.code).toBe(0)
      expect(list.stdout.trim().split('\n').slice(1)).toEqual([
        'board\tpending\tpanel\tBoard',
        'side\tpending\tsidebar\tSide',
      ])

      const pending = await runPine(['view', 'open', 'board'], env())
      expect(pending.code).toBe(1)
      expect(pending.stderr).toContain('has not enabled this view')
      expect(execCalls).toEqual([])

      store.set('board', { enabled: true })
      store.set('side', { enabled: true })
      const opened = await runPine(['view', 'open', 'board'], env())
      expect(opened.code).toBe(0)
      expect(execCalls).toEqual([
        {
          target: { windowId: 'w1', workspaceId: 's1', paneId: 'pE2E' },
          id: 'views.open',
          args: { name: 'board' },
        },
      ])

      const sidebar = await runPine(['view', 'open', 'side'], env())
      expect(sidebar.code).toBe(1)
      expect(sidebar.stderr).toContain('only placement "panel" views open as a pane')
    })
  })
})
