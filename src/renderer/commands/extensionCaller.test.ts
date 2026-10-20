import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
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

const { parseManifest } = await import('@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest')
const { runRawCommand } = await import('../../cli/verbs/commands')
const { setScriptTokenCheck } = await import('../../main/control/controlAuth')
const { registerControlServer, stopControlServer } = await import(
  '../../main/control/controlServer'
)
const { registerExtension, registerPane } = await import('../../main/control/idRegistry')
const { ExtensionHost } = await import('../../main/extensions/extensionHost')
const { extensionCommandRunner, registerExtensionMethods } = await import(
  '../../main/extensions/extensionMethods'
)
const { createExtensionIpc } = await import('../../main/extensions/extensionWiring')
const { sshCommands } = await import('../../extensions/ssh/commands')
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

const seen: Caller[] = []
const confirm = vi.fn(async () => false)
const openTerminal = vi.fn(async () => ({ ok: true as const, paneId: 'p-new' }))
const ssh = sshCommands({
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
    [
      'ssh',
      { ext: { manifest }, ready: new Map(), callerWorkspaces: new Set(), serving: new Map() },
    ],
  ]),
  active: () => true,
  runs: { reachHookCaller, declaresHook: () => false },
  processes: {
    connected: async () => ({
      sendRequest: async (
        _method: string,
        p: { command: 'connect'; args: unknown; caller: Caller },
      ) => {
        seen.push(p.caller)
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
  setScriptTokenCheck((token) =>
    token === 'script-secret' ? { id: 'script-1', caps: ['all-workspaces'] } : undefined,
  )
  registerControlServer(
    {
      isSandboxed: () => false,
      listCommandsFor: () => commands.describe(),
      execCommand: (target, id, args) =>
        invokeFromRenderer({ id, args, target }) as ReturnType<
          Parameters<typeof registerControlServer>[0]['execCommand']
        >,
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
  window.ostia.commands.publish = () => {}
  window.ostia.commands.onInvoke = (fn) => {
    invokeFromRenderer = fn as (req: unknown) => Promise<unknown>
    return () => {}
  }
  window.ostia.extensions.invoke = ((...a: unknown[]) =>
    ipcHandlers.get('extensions:invoke')?.({}, ...a)) as typeof window.ostia.extensions.invoke
  wireCommandBridge()
  syncExtensionCommands([
    { id: 'ssh', name: manifest.name, enabled: true, commands: manifest.contributes.commands },
  ] as never)
})

afterEach(() => {
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
