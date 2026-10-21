import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createTranslator } from '@aurigax-ai/ostia-extension-sdk'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/nonexistent', getPath: () => '/nonexistent' },
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => ipcHandlers.set(ch, fn),
    on: () => {},
    removeListener: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: class {},
}))
const request = vi.fn(async () => 'once' as const)
vi.mock('../../main/approvals/approvals', async (original) => ({
  ...(await original<object>()),
  approvals: () => ({ request }),
}))

const { parseManifest } = await import('@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest')
const { runRawCommand } = await import('../../cli/verbs/commands')
const { setScriptTokenCheck } = await import('../../main/control/controlAuth')
const { registerControlMethod, registerControlServer, stopControlServer } = await import(
  '../../main/control/controlServer'
)
const { dispatchGatewayMethod } = await import('../../main/gateway/controlDispatch')
const { registerExtension, registerPane } = await import('../../main/control/idRegistry')
const { ExtensionHost } = await import('../../main/extensions/extensionHost')
const { extensionCommandRunner, registerExtensionMethods } = await import(
  '../../main/extensions/extensionMethods'
)
const { createExtensionIpc } = await import('../../main/extensions/extensionWiring')
const { sshCommands } = await import('../../extensions/ssh/commands')
const { startUserActions } = await import('@/lib/palette/userActions')
const { useSettingsStore } = await import('@/stores/app/settingsStore')
const { useActionConfirmStore } = await import('@/stores/agents/actionConfirmStore')
const { syncExtensionCommands } = await import('./extensionBridge')
const { wireCommandBridge } = await import('./bridge')
const { commands } = await import('./registry')

type Caller = { kind: string; paneId?: string; workspaceId?: string; capabilities: string[] }

const sshDir = resolve(__dirname, '../../extensions/ssh')
const manifest = (() => {
  const r = parseManifest(JSON.parse(readFileSync(join(sshDir, 'ostia.json'), 'utf8')), sshDir)
  if (!r.ok) throw new Error(`manifest: ${JSON.stringify(r)}`)
  return r.manifest
})()
const probe = {
  ...manifest,
  id: 'probe',
  name: 'Probe',
  contributes: {
    ...manifest.contributes,
    commands: [
      {
        id: 'write',
        title: 'Write',
        palette: true,
        capabilities: ['type-other-pane'],
      },
    ],
  },
} as unknown as typeof manifest
const runtime = (m: typeof manifest) => ({
  ext: { manifest: m },
  ready: new Map(),
  callerWorkspaces: new Set(),
  serving: new Map(),
})

const seen: Caller[] = []
const confirm = vi.fn(async () => false)
const openTerminal = vi.fn(async () => ({ ok: true as const, paneId: 'p-new' }))
const ssh = sshCommands({
  translate: createTranslator(resolve(__dirname, '../../extensions/ssh')),
  discover: () => ({ hosts: [] }) as never,
  run: async () => ({
    code: 0,
    stdout: 'hostname box.example\nuser u\nport 22\n',
    stderr: '',
    missing: false,
    timedOut: false,
  }),
  confirm,
  openTerminal,
  shellIntegration: async () => false,
})

const reachHookCaller = vi.fn()
const host = Object.create(ExtensionHost.prototype) as InstanceType<typeof ExtensionHost>
Object.assign(host as object, {
  deps: { workDirForWorkspace: () => null, isSandboxed: () => false },
  runtimes: new Map([
    ['ssh', runtime(manifest)],
    ['probe', runtime(probe)],
  ]),
  active: () => true,
  runs: { reachHookCaller, declaresHook: () => false, holdCliCall: () => () => {} },
  processes: {
    connected: async (rt: { ext: { manifest: typeof manifest } }) => ({
      sendRequest: async (
        _method: string,
        p: { command: 'connect'; args: unknown; caller: Caller },
      ) => {
        seen.push(p.caller)
        if (rt.ext.manifest.id !== 'ssh') return { ok: true }
        return ssh[p.command](p.args as never, p.caller as never)
      },
    }),
  },
})

let invokeFromRenderer: (req: unknown) => Promise<unknown> = async () => {
  throw new Error('bridge not wired')
}

const socketPath = join(tmpdir(), `ostia-extcaller-${process.pid}.sock`)
const pane = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'pAgent' })
const other = registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'pOther' })
let stripMarks = false
const execInRenderer = (
  target: unknown,
  id: string,
  args: unknown,
  _fromMain?: boolean,
  source?: string,
) =>
  invokeFromRenderer({ id, args, target, ...(source ? { source } : {}) }) as ReturnType<
    Parameters<typeof registerControlServer>[0]['execCommand']
  >
const gatewayDeps = {
  execCommand: execInRenderer,
  listCommandsFor: () => commands.describe(),
  primaryWindowId: () => 'w1',
} as never
const conns: MessageConnection[] = []
const sockets: ReturnType<typeof createConnection>[] = []

async function connect(token: string): Promise<MessageConnection> {
  const socket = createConnection(socketPath)
  const conn = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  conn.listen()
  sockets.push(socket)
  conns.push(conn)
  await conn.sendRequest('hello', { token })
  return conn
}

async function cli(conn: MessageConnection, argv: string[]): Promise<string[]> {
  const out: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => {
    out.push(a.join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...a) => {
    out.push(a.join(' '))
  })
  const saved = process.argv
  const exit = process.exitCode
  process.argv = ['node', 'ostia', ...argv]
  try {
    await runRawCommand(conn, argv[0] ?? '')
  } finally {
    process.argv = saved
    process.exitCode = exit
    log.mockRestore()
    error.mockRestore()
  }
  return out
}

beforeAll(() => {
  const ipc = createExtensionIpc({
    services: {} as never,
    configDir: () => tmpdir(),
    workspaceWindowId: () => undefined,
    terminalState: new Map(),
    remoteCwdOfPane: () => undefined,
  } as never)
  ipc.registerExtensionIpc(host)
  registerExtensionMethods(() => host)
  registerControlMethod('workspace.list', {
    handler: () => [
      { workspaceId: 'ws1', name: 'one' },
      { workspaceId: 'ws2', name: 'two' },
    ],
  })
  setScriptTokenCheck((token) =>
    token === 'script-secret' ? { id: 'script-1', caps: ['all-workspaces'] } : undefined,
  )
  registerControlServer(
    {
      isSandboxed: () => false,
      listCommandsFor: () =>
        commands.describe().map(({ extension, ...d }) => (stripMarks ? d : { ...d, extension })),
      execCommand: execInRenderer,
      extensionCommand: extensionCommandRunner(() => host),
      getTerminalState: () => undefined,
      windowOfWorkspace: (id) => (id === 'ws1' || id === 'ws2' ? 'w1' : undefined),
    },
    socketPath,
  )
})

beforeEach(() => {
  seen.length = 0
  confirm.mockClear()
  openTerminal.mockClear()
  reachHookCaller.mockClear()
  request.mockClear()
  window.ostia.commands.publish = () => {}
  window.ostia.commands.onInvoke = (fn) => {
    invokeFromRenderer = fn as (req: unknown) => Promise<unknown>
    return () => {}
  }
  window.ostia.extensions.invoke = ((...a: unknown[]) =>
    ipcHandlers.get('extensions:invoke')?.({}, ...a)) as typeof window.ostia.extensions.invoke
  wireCommandBridge()
  syncExtensionCommands(extensionList())
})

function extensionList() {
  return [
    { id: 'ssh', name: manifest.name, enabled: true, commands: manifest.contributes.commands },
    { id: 'probe', name: probe.name, enabled: true, commands: probe.contributes.commands },
  ] as never
}

let stopActions: (() => void) | null = null

function withAction(command: string): void {
  useSettingsStore.setState({
    actions: [{ id: 'prod', title: 'Prod', command, args: { argument: 'box' }, in: [] }],
  })
  stopActions = startUserActions()
}

afterEach(() => {
  stripMarks = false
  stopActions?.()
  stopActions = null
  commands.unregister('action.prod')
  useSettingsStore.setState({ actions: [] })
  syncExtensionCommands([])
})

afterAll(() => {
  for (const c of conns) c.dispose()
  for (const s of sockets) s.destroy()
  stopControlServer()
  setScriptTokenCheck(() => undefined)
})

describe('the caller an extension command sees, by entry point', () => {
  it('ostia ssh connect (ext.invoke) arrives as the pane and asks the human', async () => {
    const conn = await connect(pane.token)
    const res = await conn.sendRequest('ext.invoke', {
      extId: 'ssh',
      command: 'connect',
      args: { argv: ['box'] },
    })
    expect(seen.map((c) => c.kind)).toEqual(['pane'])
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(openTerminal).not.toHaveBeenCalled()
    expect(res).toMatchObject({ ok: false, error: 'denied' })
  })

  it('ostia ssh.connect (command.exec) arrives as the same pane and asks the human', async () => {
    const conn = await connect(pane.token)
    const out = await cli(conn, ['ssh.connect', '{"argument":"box"}'])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'pane', paneId: pane.externalId, workspaceId: 'ws1' })
    expect(seen[0]?.capabilities).not.toContain('all-workspaces')
    expect(reachHookCaller).toHaveBeenCalledWith('ssh', 'connect', pane)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(openTerminal).not.toHaveBeenCalled()
    expect(out.join('\n')).toContain('denied')
  })

  it('a raw command.exec without the CLI is held to the same pane caller', async () => {
    const conn = await connect(pane.token)
    const res = await conn.sendRequest('command.exec', {
      id: 'ssh.connect',
      args: { argument: 'box' },
    })
    expect(seen.map((c) => c.kind)).toEqual(['pane'])
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(res).toMatchObject({ ok: false, error: { code: 'command-failed' } })
  })

  it('refuses another workspace as the target instead of running there', async () => {
    const conn = await connect(pane.token)
    await expect(
      conn.sendRequest('command.exec', {
        id: 'ssh.connect',
        args: { argument: 'box' },
        target: { workspaceId: 'ws2', paneId: null },
      }),
    ).rejects.toThrow(/runs as the calling pane/)
    expect(seen).toEqual([])
  })

  it('refuses ostia <ext>.<cmd> --workspace from the CLI', async () => {
    const conn = await connect(pane.token)
    await expect(
      cli(conn, ['ssh.connect', '{"argument":"box"}', '--workspace', 'two']),
    ).rejects.toThrow(/runs as the calling pane/)
    expect(seen).toEqual([])
  })

  it('refuses a paneId argument that points at another pane', async () => {
    const conn = await connect(pane.token)
    await expect(
      conn.sendRequest('command.exec', {
        id: 'ssh.connect',
        args: { argument: 'box', paneId: other.externalId },
      }),
    ).rejects.toThrow(/runs as the calling pane/)
    expect(seen).toEqual([])
  })

  it('fails a command the pane lacks the capability for without asking, like ext.invoke', async () => {
    const conn = await connect(pane.token)
    const direct = await conn.sendRequest('ext.invoke', { extId: 'probe', command: 'write' })
    const raw = await conn.sendRequest('command.exec', { id: 'probe.write' })
    expect(direct).toEqual({ ok: false, error: 'needs-elevation', message: 'type-other-pane' })
    expect(request).not.toHaveBeenCalled()
    expect(raw).toEqual({
      ok: false,
      error: { code: 'needs-elevation', message: 'needs-elevation: type-other-pane' },
    })
    expect(seen).toEqual([])
  })

  it('an extension command reached through the renderer from the socket is refused', async () => {
    stripMarks = true
    const conn = await connect(pane.token)
    const res = await conn.sendRequest('command.exec', {
      id: 'ssh.connect',
      args: { argument: 'box' },
    })
    expect(seen).toEqual([])
    expect(openTerminal).not.toHaveBeenCalled()
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'command-failed', message: expect.stringContaining('ostia ssh connect') },
    })
  })

  it('a pane cannot run an extension command as the user through an action', async () => {
    withAction('ssh.connect')
    const post = vi.mocked(window.ostia.notifications.post)
    const conn = await connect(pane.token)
    await conn.sendRequest('command.exec', { id: 'action.prod' })
    expect(seen).toEqual([])
    expect(confirm).not.toHaveBeenCalled()
    expect(openTerminal).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('ostia ssh connect') }),
    )
  })

  it('refuses an action wrapping an extension command before asking for trust', async () => {
    withAction('probe.write')
    const ask = vi.fn(async () => 'once' as const)
    useActionConfirmStore.setState({ ask })
    const post = vi.mocked(window.ostia.notifications.post)
    const conn = await connect(pane.token)
    await conn.sendRequest('command.exec', { id: 'action.prod' })
    expect(ask).not.toHaveBeenCalled()
    expect(seen).toEqual([])
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('ostia probe write') }),
    )
  })

  it('refuses a remote run that carries no source', async () => {
    const res = await invokeFromRenderer({
      id: 'ssh.connect',
      args: { argument: 'box' },
      target: { windowId: 'w1', workspaceId: 'ws1', paneId: 'pAgent' },
    })
    expect(seen).toEqual([])
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'command-failed', message: expect.stringContaining('ostia ssh connect') },
    })
  })

  it('a core command with the same id as an extension command still wins', async () => {
    syncExtensionCommands([])
    commands.register({ id: 'probe.write', title: 'Core write', run: () => 'core' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      syncExtensionCommands(extensionList())
      const conn = await connect(pane.token)
      const res = await conn.sendRequest('command.exec', { id: 'probe.write' })
      expect(res).toEqual({ ok: true, result: 'core' })
      expect(seen).toEqual([])
    } finally {
      warn.mockRestore()
      commands.unregister('probe.write')
    }
  })

  it('a phone gateway run is still the user', async () => {
    const res = await dispatchGatewayMethod(
      'command.exec',
      { id: 'ssh.connect', args: { argument: 'box' }, target: pane.externalId },
      ['read', 'command'],
      gatewayDeps,
    )
    expect(res).toMatchObject({ ok: true, result: { ok: true } })
    expect(seen.map((c) => c.kind)).toEqual(['user'])
    expect(confirm).not.toHaveBeenCalled()
  })

  it('refuses a phone without the command capability', async () => {
    const res = await dispatchGatewayMethod(
      'command.exec',
      { id: 'ssh.connect', args: { argument: 'box' }, target: pane.externalId },
      ['read'],
      gatewayDeps,
    )
    expect(res).toEqual({
      ok: false,
      code: -32003,
      message: 'needs-elevation',
      data: { cap: 'command' },
    })
    expect(seen).toEqual([])
  })

  it('an action the phone runs reaches the extension as the user', async () => {
    withAction('ssh.connect')
    const gated = await dispatchGatewayMethod(
      'command.exec',
      { id: 'action.prod', target: pane.externalId },
      ['read', 'command', 'notify'],
      gatewayDeps,
    )
    expect(gated).toMatchObject({ ok: false, message: 'needs-elevation' })
    expect(seen).toEqual([])
    await invokeFromRenderer({
      id: 'action.prod',
      target: { windowId: 'w1', workspaceId: 'ws1', paneId: 'pAgent' },
      source: 'phone',
    })
    expect(seen.map((c) => c.kind)).toEqual(['user'])
    expect(openTerminal).toHaveBeenCalledTimes(1)
  })

  it('keeps script tokens and extensions away from extension commands', async () => {
    const script = await connect('script-secret')
    await expect(
      script.sendRequest('command.exec', { id: 'ssh.connect', args: { argument: 'box' } }),
    ).rejects.toThrow(/not-available-to-script/)
    const ext = await connect(registerExtension('other').token)
    await expect(
      ext.sendRequest('command.exec', { id: 'ssh.connect', args: { argument: 'box' } }),
    ).rejects.toThrow(/not-available-to-extension/)
    expect(seen).toEqual([])
  })

  it('a palette run is still the user', async () => {
    const res = await commands.execWith(
      { activeWorkspaceId: 'ws1', activePaneId: 'pAgent' },
      'ssh.connect',
      { argument: 'box' },
    )
    expect(res.ok).toBe(true)
    expect(seen.map((c) => c.kind)).toEqual(['user'])
    expect(confirm).not.toHaveBeenCalled()
    expect(openTerminal).toHaveBeenCalledTimes(1)
  })
})
