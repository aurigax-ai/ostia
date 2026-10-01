import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type CancellationToken,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import type {
  AssistError,
  AssistModelList,
  AssistPoint,
  AssistReport,
  AssistRequests,
  AssistResults,
  AssistUi,
} from '../../shared/assist'
import { ALL_CAPABILITIES } from '../../shared/capabilities'
import { EXTENSION_API_ENV, EXTENSION_API_VERSION, apiProblem } from '../../shared/extensionApi'
import type {
  DiffContent,
  ExtensionCaller,
  ExtensionEventPayloads,
  ExtensionEventType,
  ExtensionIcon,
  ExtensionResult,
  ExtensionSettingValue,
  ExtensionSettingValues,
  OpenTerminalOptions,
  PaneChipItem,
  SidebarKind,
  SidebarTone,
} from '../../shared/extensions'
import { SETTINGS_CHANGED_EVENT, TARGET_PANE_PARAM } from '../../shared/extensions'
import { PANEL_SIZES_FILE, PanelSizeStore } from './panelSizes'
import { PANEL_SIZES_PATH } from './split'

export type {
  DiffContent,
  ExtensionCaller,
  ExtensionResult,
  ExtensionSettingValues,
  OpenTerminalOptions,
  PaneChipItem,
} from '../../shared/extensions'

export type AttentionVerb = 'waiting' | 'done' | 'working' | 'error' | 'clear'

export interface ChipValue {
  id: string
  text: string
  tooltip?: string
  tone?: SidebarTone
  icon?: ExtensionIcon
  items?: PaneChipItem[]
  command?: string
  url?: string
}

export interface PaneChipValue extends ChipValue {
  paneId: string
}

export interface WorkspaceChipValue extends ChipValue {
  workspaceId: string
}

export type OpenTerminalResult =
  | { ok: true; paneId: string }
  | { ok: false; error: string; message?: string }

export interface WorkspaceInfo {
  workspaceId: string
  name: string
  kind: string
  workDir: string
  state: string
  activePaneId?: string
}

export interface PaneInfo {
  paneId: string
  workspaceId: string
  kind: string
  title: string
  cwd?: string
  filePath?: string
  running: boolean
  blockCount: number
  lastExitCode?: number
  pid?: number
}

export type CommandHandler = (
  args: unknown,
  caller: ExtensionCaller,
) => ExtensionResult | Promise<ExtensionResult>

export type PanelHandler = (
  caller: ExtensionCaller,
  path?: string,
) => { url: string } | Promise<{ url: string }>

export type SettingsHandler = (values: ExtensionSettingValues) => void

export interface AssistContext {
  requestId: string
  signal: AbortSignal
  chunk: (text: string) => Promise<boolean>
}

export class AssistFailure extends Error {
  constructor(
    readonly code: AssistError,
    message?: string,
  ) {
    super(message ?? code)
  }
}

function assistFailureReply(
  err: unknown,
  aborted: boolean,
): { error: AssistError; message?: string } {
  if (aborted) return { error: 'cancelled' }
  if (err instanceof AssistFailure) return { error: err.code, message: err.message }
  return { error: 'failed', message: errorMessage(err) }
}

export type AssistHandler = <P extends AssistPoint>(
  point: P,
  input: AssistRequests[P],
  ctx: AssistContext,
) => Promise<AssistResults[P]>

export type EventHandler = <T extends ExtensionEventType>(
  type: T,
  payload: ExtensionEventPayloads[T],
) => void

export interface ConfirmRequest {
  title: string
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  hostTerminal?: string[]
}

export interface PineExtension {
  call: <T = unknown>(method: string, params?: unknown) => Promise<T>
  confirm: (req: ConfirmRequest) => Promise<boolean>
  notifyPanel: (title: string, body?: string, path?: string) => Promise<unknown>
  registerCommands: (handlers: Record<string, CommandHandler>) => Promise<void>
  onPanel: (handler: PanelHandler) => void
  subscribe: (events: ExtensionEventType[], handler: EventHandler) => Promise<unknown>
  setSidebarItem: (item: {
    key?: string
    workspaceId?: string
    text: string
    icon?: ExtensionIcon
    tone?: SidebarTone
    kind?: SidebarKind
    url?: string
  }) => Promise<unknown>
  notify: (title: string, body?: string) => Promise<unknown>
  openPanel: (workspaceId?: string, path?: string) => Promise<unknown>
  setPaneChip: (chip: PaneChipValue) => Promise<ExtensionResult>
  clearPaneChip: (paneId: string, id: string) => Promise<ExtensionResult>
  setWorkspaceChip: (chip: WorkspaceChipValue) => Promise<ExtensionResult>
  clearWorkspaceChip: (workspaceId: string, id: string) => Promise<ExtensionResult>
  getSettings: () => Promise<ExtensionSettingValues>
  setSetting: (key: string, value: ExtensionSettingValue | null) => Promise<ExtensionResult>
  onSettingsChanged: (handler: SettingsHandler) => void
  callAs: <T = unknown>(paneId: string, method: string, params?: object) => Promise<T>
  setAttention: (paneId: string, state: AttentionVerb, message?: string) => Promise<unknown>
  openDiff: (diff: DiffContent & { workspaceId?: string }) => Promise<ExtensionResult>
  openTerminal: (opts: OpenTerminalOptions) => Promise<OpenTerminalResult>
  listWorkspaces: () => Promise<WorkspaceInfo[]>
  listPanes: () => Promise<PaneInfo[]>
  onAssist: (handler: AssistHandler) => void
  onAssistModels: (handler: AssistModelsHandler) => void
  setAssistStatus: (report: AssistReport) => Promise<unknown>
  getShortcuts: (ids: string[]) => Promise<Record<string, string | null>>
  openAssistUi: (ui: AssistUi, workspaceId?: string) => Promise<ExtensionResult>
  getSecret: (key: string) => Promise<string | null>
}

export interface AssistModelsHandler {
  list: () => Promise<AssistModelList>
  setLoaded: (id: string, loaded: boolean) => Promise<void>
}

export { EXTENSION_API_VERSION } from '../../shared/extensionApi'

export function ok(text?: string, data?: unknown): ExtensionResult {
  const result: ExtensionResult = { ok: true }
  if (text !== undefined) result.text = text
  if (data !== undefined) result.data = data
  return result
}

export function failure(error: string, message?: string): ExtensionResult {
  return message ? { ok: false, error, message } : { ok: false, error }
}

export function numberSetting(
  values: ExtensionSettingValues,
  key: string,
  fallback: number,
  range: { min: number; max: number },
): number {
  const value = values[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(range.max, Math.max(range.min, value))
}

export function booleanSetting(
  values: ExtensionSettingValues,
  key: string,
  fallback: boolean,
): boolean {
  const value = values[key]
  return typeof value === 'boolean' ? value : fallback
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function connect(): Promise<PineExtension> {
  const socketPath = process.env.PINE_SOCKET
  const token = process.env.PINE_TOKEN
  if (!socketPath || !token) throw new Error('PINE_SOCKET / PINE_TOKEN missing')
  const provided = process.env[EXTENSION_API_ENV]
  const incompatible = provided ? apiProblem(EXTENSION_API_VERSION, provided) : null
  if (incompatible) throw new Error(`this extension ${incompatible}`)
  const socket = createConnection(socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const conn: MessageConnection = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  const handlers = new Map<string, CommandHandler>()
  let panelHandler: PanelHandler | null = null
  let eventHandler: EventHandler | null = null
  let settingsHandler: SettingsHandler | null = null
  let assistHandler: AssistHandler | null = null
  let modelsHandler: AssistModelsHandler | null = null

  conn.onRequest(
    'ext.command',
    async (params: { command: string; args: unknown; caller: ExtensionCaller }) => {
      const handler = handlers.get(params.command)
      if (!handler) return failure('unknown-command', params.command)
      try {
        return await handler(params.args, params.caller)
      } catch (err) {
        return failure('command-failed', errorMessage(err))
      }
    },
  )
  conn.onRequest(
    'ext.assist',
    async (
      params: { point: AssistPoint; requestId: string; input: never },
      token: CancellationToken,
    ) => {
      if (!assistHandler) throw new Error('no assist handler')
      const abort = new AbortController()
      const sub = token.onCancellationRequested(() => abort.abort())
      if (token.isCancellationRequested) abort.abort()
      try {
        return await assistHandler(params.point, params.input, {
          requestId: params.requestId,
          signal: abort.signal,
          chunk: async (text) => {
            if (abort.signal.aborted) return false
            const res = await conn.sendRequest<{ live?: unknown }>('ext.assistChunk', {
              requestId: params.requestId,
              text,
            })
            return res?.live === true
          },
        })
      } catch (err) {
        return assistFailureReply(err, abort.signal.aborted)
      } finally {
        sub.dispose()
      }
    },
  )
  conn.onRequest('ext.assistModels', async (params: { action?: unknown; id?: unknown }) => {
    if (!modelsHandler) throw new Error('no models handler')
    if (params.action === 'list') return modelsHandler.list()
    if ((params.action !== 'load' && params.action !== 'unload') || typeof params.id !== 'string') {
      return { ok: false, error: 'invalid' }
    }
    try {
      await modelsHandler.setLoaded(params.id, params.action === 'load')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  conn.onRequest('ext.panel', async (params: { caller: ExtensionCaller; path?: string }) => {
    if (!panelHandler) throw new Error('no panel handler')
    return panelHandler(params.caller, params.path)
  })
  conn.onNotification(
    'ext.event',
    (params: { type: ExtensionEventType | typeof SETTINGS_CHANGED_EVENT; payload: never }) => {
      if (params.type === SETTINGS_CHANGED_EVENT) {
        settingsHandler?.((params.payload as { values: ExtensionSettingValues }).values)
      } else {
        eventHandler?.(params.type, params.payload)
      }
    },
  )
  conn.onClose(() => process.exit(0))
  socket.on('close', () => process.exit(0))
  conn.listen()
  await conn.sendRequest('hello', { token })

  return {
    call: <T>(method: string, params?: unknown) =>
      params === undefined
        ? conn.sendRequest<T>(method)
        : conn.sendRequest<T>(method, params as object),
    confirm: async (req) => {
      const res = await conn.sendRequest<{ confirmed?: unknown }>('ext.confirm', req)
      return res?.confirmed === true
    },
    notifyPanel: (title, body, path) =>
      conn.sendRequest('ext.notify', { title, body, openPanel: path ?? true }),
    registerCommands: async (map) => {
      for (const [id, handler] of Object.entries(map)) handlers.set(id, handler)
      await conn.sendRequest('ext.registerCommands', { commands: Object.keys(map) })
    },
    onPanel: (handler) => {
      panelHandler = handler
    },
    subscribe: (events, handler) => {
      eventHandler = handler
      return conn.sendRequest('ext.subscribe', { events })
    },
    setSidebarItem: (item) => conn.sendRequest('ext.setSidebarItem', item),
    notify: (title, body) => conn.sendRequest('ext.notify', { title, body }),
    openPanel: (workspaceId, path) => conn.sendRequest('ext.openPanel', { workspaceId, path }),
    setPaneChip: (chip) => conn.sendRequest('ext.setPaneChip', chip),
    clearPaneChip: (paneId, id) => conn.sendRequest('ext.clearPaneChip', { paneId, id }),
    setWorkspaceChip: (chip) => conn.sendRequest('ext.setWorkspaceChip', chip),
    clearWorkspaceChip: (workspaceId, id) =>
      conn.sendRequest('ext.clearWorkspaceChip', { workspaceId, id }),
    getSettings: async () => {
      const res = await conn.sendRequest<{ values?: ExtensionSettingValues }>('ext.getSettings')
      return res?.values ?? {}
    },
    setSetting: (key, value) => conn.sendRequest('ext.setSetting', { key, value }),
    onSettingsChanged: (handler) => {
      settingsHandler = handler
    },
    callAs: <T>(paneId: string, method: string, params?: object) =>
      conn.sendRequest<T>(method, { ...params, [TARGET_PANE_PARAM]: paneId }),
    setAttention: (paneId, state, message) =>
      conn.sendRequest('pane.setAttention', { [TARGET_PANE_PARAM]: paneId, state, message }),
    openDiff: (diff) => conn.sendRequest('ext.openDiff', diff),
    openTerminal: async (opts) => {
      try {
        return await conn.sendRequest<OpenTerminalResult>('ext.openTerminal', opts)
      } catch (err) {
        return { ok: false, error: 'open-terminal-failed', message: errorMessage(err) }
      }
    },
    listWorkspaces: () => conn.sendRequest('workspace.list'),
    listPanes: () => conn.sendRequest('pane.list'),
    onAssist: (handler) => {
      assistHandler = handler
    },
    onAssistModels: (handler) => {
      modelsHandler = handler
    },
    setAssistStatus: (report) => conn.sendRequest('ext.setAssistStatus', report),
    getShortcuts: async (ids) => {
      const res = await conn.sendRequest<{ shortcuts?: Record<string, string | null> }>(
        'ext.shortcuts',
        { ids },
      )
      return res?.shortcuts ?? {}
    },
    openAssistUi: (ui, workspaceId) =>
      conn.sendRequest('ext.openAssistUi', workspaceId ? { ui, workspaceId } : { ui }),
    getSecret: async (key) => {
      const res = await conn.sendRequest<{ value?: unknown }>('ext.getSecret', { key })
      return typeof res?.value === 'string' ? res.value : null
    },
  }
}

export function onShutdown(fn: () => void): void {
  let ran = false
  const once = (): void => {
    if (ran) return
    ran = true
    try {
      fn()
    } catch {}
  }
  process.on('exit', once)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
      once()
      process.exit(0)
    })
  }
}

export { nextBackoff, runTool, type ToolRun, type ToolRunOptions } from './tool'
export { type MessagePageServer, startMessageServer } from './messagePage'

export interface CliArgs {
  argv: string[]
  stdin?: string
}

export function cliArgs(args: unknown): CliArgs | null {
  if (typeof args !== 'object' || args === null) return null
  const argv = (args as { argv?: unknown }).argv
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) return null
  const stdin = (args as { stdin?: unknown }).stdin
  return typeof stdin === 'string' ? { argv, stdin } : { argv }
}

export function namedArgs(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

export function parseFlags(
  argv: string[],
  valueFlags: string[],
  boolFlags: string[] = [],
): { flags: Record<string, string>; bools: Set<string>; rest: string[] } {
  const flags: Record<string, string> = {}
  const bools = new Set<string>()
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const name = arg.startsWith('--') ? arg.slice(2) : ''
    if (valueFlags.includes(name) && i + 1 < argv.length) {
      flags[name] = argv[++i]
    } else if (boolFlags.includes(name)) {
      bools.add(name)
    } else {
      rest.push(arg)
    }
  }
  return { flags, bools, rest }
}

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function panelCaller(context: Record<string, unknown>): ExtensionCaller {
  const caller: ExtensionCaller = { kind: 'user', capabilities: [...ALL_CAPABILITIES] }
  if (typeof context.workDir === 'string' && context.workDir) caller.workDir = context.workDir
  if (typeof context.workspaceId === 'string' && context.workspaceId) {
    caller.workspaceId = context.workspaceId
  }
  if (typeof context.locale === 'string' && context.locale) caller.locale = context.locale
  return caller
}

export interface PanelServer {
  url: (query: Record<string, string>) => string
  changed: () => void
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

const MAX_BODY = 1024 * 1024

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; font-src 'self' data:",
  })
  res.end(body)
}

export async function startPanelServer(opts: {
  dir: string
  files: string[]
  handle: (command: string, args: unknown, caller: ExtensionCaller) => Promise<ExtensionResult>
}): Promise<PanelServer> {
  const secret = randomBytes(24).toString('hex')
  const sizes = new PanelSizeStore(
    process.env.PINE_EXTENSION_DATA
      ? join(process.env.PINE_EXTENSION_DATA, PANEL_SIZES_FILE)
      : null,
  )
  const streams = new Set<ServerResponse>()
  let port = 0

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 421, 'text/plain', 'bad host')
    const origin = req.headers.origin
    if (origin && origin !== `http://127.0.0.1:${port}`)
      return send(res, 403, 'text/plain', 'origin')
    const authed = req.headers['x-pine-panel'] === secret || url.searchParams.get('t') === secret

    if (req.method === 'GET' && url.pathname === '/events') {
      if (!authed) return send(res, 403, 'text/plain', 'forbidden')
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write(': ok\n\n')
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return
    }
    if (url.pathname === PANEL_SIZES_PATH) {
      if (req.headers['x-pine-panel'] !== secret) return send(res, 403, 'text/plain', 'forbidden')
      if (req.method === 'GET')
        return send(res, 200, 'application/json', JSON.stringify(sizes.all()))
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed')
      try {
        const body = JSON.parse(await readBody(req)) as { key?: unknown; fraction?: unknown }
        if (!sizes.set(body.key, body.fraction ?? null)) throw new Error('key, fraction')
        return send(res, 200, 'application/json', JSON.stringify(sizes.all()))
      } catch (err) {
        return send(
          res,
          400,
          'application/json',
          JSON.stringify(failure('bad-request', errorMessage(err))),
        )
      }
    }
    if (req.method === 'POST' && url.pathname === '/api') {
      if (req.headers['x-pine-panel'] !== secret) return send(res, 403, 'text/plain', 'forbidden')
      try {
        const body = JSON.parse(await readBody(req)) as {
          command?: unknown
          args?: unknown
          context?: Record<string, unknown>
        }
        if (typeof body.command !== 'string') throw new Error('missing command')
        const result = await opts.handle(body.command, body.args, panelCaller(body.context ?? {}))
        return send(res, 200, 'application/json', JSON.stringify(result))
      } catch (err) {
        return send(
          res,
          400,
          'application/json',
          JSON.stringify(failure('bad-request', errorMessage(err))),
        )
      }
    }
    if (req.method === 'GET') {
      const name = url.pathname === '/' ? 'panel.html' : url.pathname.slice(1)
      if (!opts.files.includes(name)) return send(res, 404, 'text/plain', 'not found')
      const ext = name.slice(name.lastIndexOf('.'))
      try {
        return send(
          res,
          200,
          CONTENT_TYPES[ext] ?? 'application/octet-stream',
          readFileSync(join(opts.dir, name)),
        )
      } catch {
        return send(res, 404, 'text/plain', 'not found')
      }
    }
    send(res, 405, 'text/plain', 'method not allowed')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0

  return {
    url: (query) => {
      const params = new URLSearchParams({ ...query, t: secret })
      return `http://127.0.0.1:${port}/?${params.toString()}`
    },
    changed: () => {
      for (const res of streams) res.write('data: changed\n\n')
    },
  }
}
