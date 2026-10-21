import { spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ExtensionResult } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { runtimePaths } from '@aurigax-ai/wire'
import type { AgentResume } from '../src/shared/agents/agentResume'
import type { CommandResult } from '../src/shared/control/commands'
import { journalLines } from './journalLines'

const repoRoot = process.cwd()
const CLI = join(repoRoot, 'out', 'cli', 'index.js')
export const SCAN_EXPLODES = 'scan-explodes-here'
export const FAKE_TOOL = join(repoRoot, 'test', 'fixtures', 'tools', 'bin', 'fake-tool')
export const FAKE_MCP_SERVER = join(repoRoot, 'test', 'fixtures', 'mcp', 'fake-server.mjs')
export const MCP_SECRET = ['mcp', 'tok', 'Q'.repeat(28)].join('_')

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

interface FakePane {
  internalId: string
  externalId: string
  token: string
  workspaceId: string
  agent?: string
  agentState?: string
  agentSessionId?: string
  hibernated?: boolean
  command?: string
  backgroundTab?: boolean
  cwd?: string
}

export interface Harness {
  dir: string
  workDir: string
  otherDir: string
  dataDir: string
  panes: Map<string, FakePane>
  opened: FakePane[]
  notices: { title: string; body?: string; panelPath?: string }[]
  resumes: Map<string, AgentResume>
  onOpen: (pane: FakePane) => void
  logs: string[]
  human: FakePane
  stranger: FakePane
  scratchPane: FakePane
  remotePane: FakePane
  managerPane: FakePane
  writeGraph: (name: string, text: string) => string
  cli: (pane: FakePane, args: string[], stdin?: string) => Promise<CliResult>
  panel: (command: string, args?: Record<string, unknown>) => Promise<ExtensionResult>
  enable: (name: string) => Promise<ExtensionResult>
  stop: (pane: FakePane, payload: Record<string, unknown>) => Promise<CliResult>
  stopAll: () => void
  wireData: string
  journal: (runId: string) => Record<string, unknown>[]
  runIds: (graph: string) => string[]
  host: import('../src/main/extensions/extensionHost').ExtensionHost
  launches: import('../src/main/extensions/extensionLaunches').ExtensionLaunches | null
  secrets: import('../src/main/extensions/extensionHostDeps').ExtensionSecretStore
}

export const POLL = { timeout: 15_000, interval: 50 }

function runCli(args: string[], env: NodeJS.ProcessEnv, stdin = ''): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`ostia ${args.join(' ')} timed out (${stdout} ${stderr})`))
    }, 30_000)
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString()
    })
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString()
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(stdin)
  })
}

export async function graphsHarness(
  opts: { activity?: boolean; mcp?: boolean; connections?: boolean; launches?: boolean } = {},
): Promise<Harness> {
  const { registerControlServer } = await import('../src/main/control/controlServer')
  const { registerPane, markManager, getByPaneId } = await import('../src/main/control/idRegistry')
  const { ExtensionHost } = await import('../src/main/extensions/extensionHost')
  const { registerExtensionMethods } = await import('../src/main/extensions/extensionMethods')
  const { ExtensionStore } = await import('../src/main/extensions/extensionStore')
  const { ExtensionExec } = await import('../src/main/extensions/extensionExec')
  const { registerPaneListMethods } = await import('../src/main/panes/paneList')
  const { registerBusMethods } = await import('../src/main/agents/busMethods')
  const { registerExtensionQuestions, registerQuestions } = await import(
    '../src/main/approvals/questions'
  )
  const { registerDocsMethods } = await import('../src/main/control/docs')
  const { createRedactor } = await import('../src/main/privacy/redaction')
  const { scanSecrets } = await import('../src/main/privacy/secretScanner')
  const { McpHost } = await import('../src/main/chat/mcpHost')
  const { registerExtensionMcp } = await import('../src/main/chat/extensionMcp')
  const { ExtensionConnections } = await import('../src/main/extensions/extensionConnections')
  const { createSecretStore } = await import('../src/main/extensions/extensionSecrets')
  const { ExtensionLaunches } = await import('../src/main/extensions/extensionLaunches')
  const { WireRuntime, registerWireRuntime } = await import('../src/main/extensions/wireRuntime')

  const dir = mkdtempSync(join(tmpdir(), 'ostia-graphs-'))
  const workDir = join(dir, 'shop')
  const otherDir = join(dir, 'other')
  const dataDir = join(dir, 'extension-data')
  const socketPath = join(dir, 'control.sock')
  for (const d of [join(workDir, '.ostia/graphs'), join(otherDir, '.ostia/graphs'), dataDir])
    mkdirSync(d, { recursive: true })
  cpSync(join(repoRoot, 'out/extensions/graphs'), join(dir, 'builtin/graphs'), { recursive: true })
  if (opts.activity)
    cpSync(join(repoRoot, 'out/extensions/activity'), join(dir, 'builtin/activity'), {
      recursive: true,
    })

  const panes = new Map<string, FakePane>()
  const opened: FakePane[] = []
  const notices: Harness['notices'] = []
  const resumes = new Map<string, AgentResume>()
  let counter = 0
  let agentClock = 0
  const logs: string[] = []
  const addPane = (workspaceId: string, fields: Partial<FakePane> = {}): FakePane => {
    counter += 1
    const internalId = `gp${counter}`
    const identity = registerPane({ windowId: 'w', workspaceId, paneId: internalId })
    const pane: FakePane = {
      internalId,
      externalId: identity.externalId,
      token: identity.token,
      workspaceId,
      ...fields,
    }
    panes.set(internalId, pane)
    return pane
  }
  const human = addPane('w1')
  const stranger = addPane('w2')
  const scratchPane = addPane('sc1')
  const remotePane = addPane('w1')
  const managerPane = addPane('w1')
  markManager(managerPane.internalId)
  const workDirs: Record<string, string> = { w1: workDir, w2: otherDir, sc1: join(dir, 'scratch') }
  const redactor = createRedactor(
    () => ({ redaction: { enabled: true } }),
    (text) => {
      if (text.includes(SCAN_EXPLODES)) throw new Error('the scanner stopped')
      return scanSecrets(text)
    },
  )

  let storedSecrets: unknown = {}
  const secretStore = createSecretStore({
    load: () => storedSecrets,
    save: (data) => {
      storedSecrets = data
    },
    canEncrypt: () => true,
    encrypt: (plain) => Buffer.from(plain).toString('base64'),
    decrypt: (stored) => Buffer.from(stored, 'base64').toString(),
  })
  const connections = opts.connections
    ? new ExtensionConnections(join(dir, 'extension-connections.json'), () => secretStore)
    : undefined
  const launches = opts.launches
    ? new ExtensionLaunches(join(dir, 'extension-launches.json'))
    : null
  const host = new ExtensionHost({
    isSandboxed: () => false,
    sandboxDomains: () => null,
    ...(connections ? { connections, secrets: secretStore } : {}),
    ...(launches ? { launches } : {}),
    roots: [{ dir: join(dir, 'builtin'), builtin: true }],
    store: new ExtensionStore(join(dir, 'extensions.json')),
    socketPath: () => socketPath,
    nodePath: process.execPath,
    dataDir,
    workDirForWorkspace: (id) => (id ? workDirs[id] : undefined),
    cwdForPane: (paneId) => workDirs[panes.get(paneId)?.workspaceId ?? ''],
    agentRunning: (paneId) => panes.get(paneId)?.agent !== undefined,
    remoteCwdForPane: (paneId) =>
      (paneId === remotePane.internalId ? { host: 'box', cwd: '/srv' } : undefined) as never,
    broadcast: () => {},
    redact: redactor.redact,
    openPanelIn: () => {},
    notify: (n) => notices.push(n),
    notifyPanel: (n) =>
      notices.push({
        title: n.title,
        ...(n.body ? { body: n.body } : {}),
        ...(n.panelPath ? { panelPath: n.panelPath } : {}),
      }),
    openTerminalIn: async (req) => {
      const pane = addPane(req.workspaceId ?? 'w1', {
        agent: 'claude',
        agentState: 'working',
        command: req.command,
        ...(req.backgroundTab ? { backgroundTab: true } : {}),
        ...(req.cwd ? { cwd: req.cwd } : {}),
      })
      opened.push(pane)
      harness.onOpen(pane)
      return pane.externalId
    },
    agentArgv: (name) => ({ claude: ['claude'], codex: ['codex'] })[name] ?? null,
    agentNames: () => ['claude', 'codex'],
    focusPaneIn: () => true,
    agentTaskClock: () => {
      agentClock += 61_000
      return agentClock
    },
    exec: new ExtensionExec({
      workspace: (id) =>
        workDirs[id] ? { workDir: workDirs[id], scratch: id === 'sc1', sandboxed: false } : null,
      wrap: async (_id, command) => command,
      sandboxEnv: (_id, env) => env,
      dataDir: (extId) => join(dataDir, extId),
      baseEnv: () => ({
        PATH: `${dirname(FAKE_TOOL)}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: dir,
      }),
    }),
    resumeOf: async (pane) => {
      const resume = resumes.get(pane.externalId)
      if (!resume) return null
      const held = [...panes.values()].some(
        (p) => p.agentSessionId === resume.id && p.agent === resume.agent && !p.hibernated,
      )
      return { resume, held }
    },
    requestTimeoutMs: 8000,
    readyTimeoutMs: 8000,
    interactiveTimeoutMs: 15_000,
    log: (extId, line) => logs.push(`${extId}: ${line}`),
  })
  registerExtensionMethods(() => host)
  const wireEnv = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: dir,
    XDG_STATE_HOME: join(dir, 'wire-state'),
    XDG_RUNTIME_DIR: join(dir, 'wire-run'),
    TMPDIR: dir,
  }
  mkdirSync(wireEnv.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 })
  const wirePaths = {
    env: wireEnv,
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    home: dir,
    tmp: dir,
  }
  const wireData = runtimePaths(wirePaths).data
  registerWireRuntime({
    host: () => host,
    runtime: new WireRuntime({
      nodePath: process.execPath,
      baseEnv: () => wireEnv,
      pathEnv: () => wirePaths,
    }),
  })
  const mcp = opts.mcp
    ? new McpHost({
        servers: () => [
          {
            name: 'fake',
            enabled: true,
            command: [process.execPath, FAKE_MCP_SERVER],
            env: {},
            secrets: ['FAKE_TOKEN'],
            disabledTools: ['fail'],
          },
          {
            name: 'quiet',
            enabled: false,
            command: [process.execPath, FAKE_MCP_SERVER],
            env: {},
            secrets: [],
            disabledTools: [],
          },
        ],
        secret: (server, key) => (server === 'fake' && key === 'FAKE_TOKEN' ? MCP_SECRET : null),
        onStatus: () => {},
        connectTimeoutMs: 10_000,
        callTimeoutMs: 5000,
      })
    : null
  registerExtensionMcp({ mcp: () => mcp })
  if (opts.mcp) host.processes.approve('graphs')
  registerBusMethods({
    hibernated: () => false,
    managerSendAllowed: () => true,
    agentBusy: () => false,
    announce: () => {},
    pending: async () => 'idle-no-wake',
    reach: {
      processPane: async () => [],
      visible: async () => () => true,
      inScope: async () => true,
      isChild: () => false,
      isSandboxed: () => false,
      isConfined: () => false,
    },
  })
  registerQuestions({ opened: () => {}, settled: () => {} })
  registerExtensionQuestions({
    windowOfWorkspace: (id) => (workDirs[id] ? '7' : undefined),
    extensionName: (id) => host.displayName(id),
  })
  registerDocsMethods({ extensions: () => host.list() })
  registerPaneListMethods({
    execCommand: async (_target, id) =>
      ({
        ok: true,
        result:
          id === 'workspace.list'
            ? [
                { workspaceId: 'w1', name: 'shop', kind: 'terminal', workDir, state: 'idle' },
                {
                  workspaceId: 'w2',
                  name: 'other',
                  kind: 'terminal',
                  workDir: otherDir,
                  state: 'idle',
                },
                {
                  workspaceId: 'sc1',
                  name: 'notes',
                  kind: 'scratch',
                  workDir: workDirs.sc1,
                  state: 'idle',
                },
              ]
            : [...panes.values()].map((p) => ({
                paneId: p.internalId,
                workspaceId: p.workspaceId,
                kind: 'terminal',
                title: p.agent ?? 'bash',
                ...(p.agent ? { agent: p.agent, agentState: p.agentState ?? 'working' } : {}),
                ...(p.agentSessionId ? { agentSessionId: p.agentSessionId } : {}),
                ...(p.hibernated ? { hibernated: true } : {}),
              })),
      }) as CommandResult,
    getTerminalState: () => undefined,
    ptyPid: () => undefined,
    windowIds: () => ['w'],
    waking: () => false,
  })
  registerControlServer(
    {
      execCommand: async () => ({ ok: true, result: null }) as CommandResult,
      listCommandsFor: () => [],
      getTerminalState: () => undefined,
      isSandboxed: () => false,
    },
    socketPath,
  )
  void getByPaneId

  const env = (pane: FakePane): NodeJS.ProcessEnv => ({
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: dir,
    OSTIA_SOCKET: socketPath,
    OSTIA_TOKEN: pane.token,
  })
  const panel = async (
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<ExtensionResult> => {
    const source = await host.panels.resolvePanel('graphs', { workspaceId: 'w1', locale: 'en' })
    if (!source.ok) throw new Error(source.error)
    const url = new URL(source.src)
    const res = await fetch(new URL('/api', url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ostia-panel': url.searchParams.get('t') ?? '',
      },
      body: JSON.stringify({
        command,
        args: { workspaceId: 'w1', ...args },
        context: { workspaceId: 'w1' },
      }),
    })
    return (await res.json()) as ExtensionResult
  }
  const harness: Harness = {
    dir,
    workDir,
    otherDir,
    dataDir,
    panes,
    opened,
    notices,
    resumes,
    onOpen: () => {},
    logs,
    human,
    stranger,
    scratchPane,
    remotePane,
    managerPane,
    host,
    launches,
    writeGraph: (name, text) => {
      const path = join(workDir, '.ostia/graphs', `${name}.yaml`)
      writeFileSync(path, text)
      return path
    },
    cli: (pane, args, stdin) => runCli(args, env(pane), stdin),
    panel,
    enable: async (name) => {
      const def = await panel('definition', { name })
      if (!def.ok) return def
      return panel('enable', {
        name,
        fingerprint: (def.data as { fingerprint: string }).fingerprint,
      })
    },
    stop: (pane, payload) =>
      runCli(
        ['graph', 'on-stop', 'claude', 'Stop'],
        env(pane),
        JSON.stringify({ session_id: 's-1', ...payload }),
      ),
    secrets: secretStore,
    wireData,
    journal: (runId) => {
      const root = join(wireData, 'runs')
      for (const scope of existsSync(root) ? readdirSync(root) : [])
        for (const graph of readdirSync(join(root, scope))) {
          const file = join(root, scope, graph, runId, 'journal.jsonl')
          if (existsSync(file)) return journalLines(readFileSync(file, 'utf8'))
        }
      return []
    },
    runIds: (graph) => {
      const root = join(wireData, 'runs')
      return (existsSync(root) ? readdirSync(root) : []).flatMap((scope) =>
        existsSync(join(root, scope, graph)) ? readdirSync(join(root, scope, graph)) : [],
      )
    },
    stopAll: () => {
      host.processes.stopAll()
      mcp?.closeAll()
      try {
        const pid = Number(readFileSync(join(wireData, 'runtime.lock'), 'utf8').trim())
        if (pid > 0) process.kill(pid, 'SIGKILL')
      } catch {}
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return harness
}
