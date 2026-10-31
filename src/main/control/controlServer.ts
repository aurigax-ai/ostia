import { hash } from 'node:crypto'
import { chmodSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Capability,
  DEFAULT_CAPABILITIES,
} from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import { TARGET_PANE_PARAM } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import {
  type CancellationToken,
  createMessageConnection,
  ErrorCodes,
  type MessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'
import { verbCode } from '../../shared/agents/agentIssues'
import type {
  CommandDescriptor,
  CommandResult,
  CommandSource,
  CommandTarget,
} from '../../shared/control/commands'
import type { TerminalStateSnapshot } from '../../shared/terminal/ptyApi'
import { ensureCaps, needsElevation } from '../approvals/controlElevation'
import type { Reach, ScriptReach } from '../approvals/reach'
import type { ScriptTokenUsageLog } from '../approvals/scriptTokenUsage'
import type { AgentJournal } from '../diagnostics/agentJournal'
import { privateRunDir, shortSocketDir, socketPath } from '../platform/privateTmp'
import { SANDBOXED_REFUSAL } from '../sandbox/sandboxedCaller'
import { externalPaneMessage, internalPaneArgs, SCRIPT_COMMANDS } from './commandArgs'
import { type AuthedConn, authenticate, connHasCap, scriptExpired } from './controlAuth'
import { type PaneIdentity, resolveExternal } from './idRegistry'
import { capIncomingMessages } from './messageCap'
import { calledMethod, calledTarget, errorOutcome, resultOutcome } from './scriptCallUsage'

const CONTROL_SOCKET = new RegExp(`^(?:[0-9a-f]{16}-)?${PRODUCT_NAME}-(\\d+)\\.sock$`)

function controlSocketDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') return privateRunDir('control', platform, env)
  return env.XDG_RUNTIME_DIR || tmpdir()
}

export function controlSocketPathFor(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return socketPath(controlSocketDir(platform, env), `${PRODUCT_NAME}-${pid}.sock`, platform)
}

export function controlSocketPath(): string {
  return controlSocketPathFor(process.pid)
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function sweepStaleControlSockets(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  running: (pid: number) => boolean = isRunning,
): void {
  if (platform !== 'darwin') return
  for (const dir of [controlSocketDir(platform, env), shortSocketDir()]) {
    sweepDeadSockets(dir, running)
  }
}

function sweepDeadSockets(dir: string, running: (pid: number) => boolean): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const pid = Number(CONTROL_SOCKET.exec(name)?.[1])
    if (!pid || pid === process.pid || running(pid)) continue
    try {
      rmSync(join(dir, name), { force: true })
    } catch {}
  }
}

function keptSocketName(userData: string): string {
  return `${hash('sha256', userData).slice(0, 16)}.sock`
}

export function keptControlSocketPath(
  userData: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return socketPath(privateRunDir('kept', platform, env), keptSocketName(userData), platform)
}

function unauthenticatedError(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, message)
}

type ControlCallers = 'panes' | 'extensions' | 'manager' | 'all'

export type ControlConn = Pick<MessageConnection, 'onClose' | 'onDispose'>

export interface ControlMethodContext {
  identity: PaneIdentity
  authed: AuthedConn
  conn: ControlConn
  token?: CancellationToken
}

export interface ExtensionMethodContext extends ControlMethodContext {
  conn: MessageConnection
}

export interface ControlMethod {
  cap?: Capability
  callers?: ControlCallers
  scripts?: boolean
  targetable?: boolean
  handler(params: unknown, ctx: ControlMethodContext): unknown | Promise<unknown>
}

const DETAIL_HIDDEN_PREFIXES = ['vault.', 'secret.']

function describeParams(method: string, params: unknown): string {
  if (DETAIL_HIDDEN_PREFIXES.some((p) => method.startsWith(p))) return ''
  if (params === undefined) return ''
  try {
    return JSON.stringify(params)
  } catch {
    return ''
  }
}

function callerPid(raw: unknown): number | undefined {
  return Number.isSafeInteger(raw) && (raw as number) > 0 ? (raw as number) : undefined
}

function callerAllowed(identity: PaneIdentity, callers: ControlCallers, scripts = false): boolean {
  if (identity.kind === 'script') return scripts
  if (callers === 'all') return true
  if (callers === 'manager') return identity.kind === 'pane' && identity.manager === true
  return callers === 'extensions' ? identity.kind === 'extension' : identity.kind === 'pane'
}

const methods = new Map<string, ControlMethod>()

export function registerControlMethod(name: string, method: ControlMethod): void {
  if (methods.has(name)) throw new Error(`control method already registered: ${name}`)
  methods.set(name, method)
}

export function registerTargetableMethod(name: string, method: ControlMethod): void {
  registerControlMethod(name, { ...method, targetable: true })
}

const GROUP_ARG_COMMANDS: ReadonlySet<string> = new Set([
  'workspace.groupColor',
  'workspace.groupRename',
  'workspace.groupDelete',
])

function argOf(args: unknown, key: 'group' | 'name'): unknown {
  return typeof args === 'object' && args !== null
    ? (args as Record<string, unknown>)[key]
    : undefined
}

function scriptTargetInScope(
  scoped: ScriptReach | null,
  id: string,
  targetless: boolean,
  target: CommandTarget,
  args: unknown,
): boolean {
  if (!scoped) return false
  if (targetless) {
    const group = scoped.groupNamed(argOf(args, 'group'))
    if (id === 'workspace.new') return scoped.ownWorkspaces && scoped.hasGroup(group ?? '')
    if (!GROUP_ARG_COMMANDS.has(id) || !scoped.hasGroup(group ?? '')) return false
    if (id !== 'workspace.groupRename') return true
    const taken = scoped.groupNamed(argOf(args, 'name'))
    return taken === undefined || scoped.hasGroup(taken)
  }
  if (!target.workspaceId || !scoped.covers(target.workspaceId)) return false
  if (id === 'workspace.group') return scoped.hasGroup(scoped.groupNamed(argOf(args, 'name')) ?? '')
  return true
}

function actingPane(
  authed: AuthedConn,
  params: unknown,
): { identity: PaneIdentity; params: Record<string, unknown> } {
  if (!connHasCap(authed, 'all-workspaces')) throw needsElevation('all-workspaces')
  const raw = (typeof params === 'object' && params !== null ? params : {}) as Record<
    string,
    unknown
  >
  const { [TARGET_PANE_PARAM]: targetId, ...rest } = raw
  const target = typeof targetId === 'string' ? resolveExternal(targetId) : undefined
  if (!targetId) {
    throw new ResponseError(ErrorCodes.InvalidParams, `needs-target: ${TARGET_PANE_PARAM}`)
  }
  if (target?.kind !== 'pane') {
    throw new ResponseError(ErrorCodes.InvalidParams, `unknown-target: ${String(targetId)}`)
  }
  return { identity: target, params: rest }
}

export type ExtensionCommandRun = (identity: PaneIdentity, args: unknown) => Promise<CommandResult>

export interface ControlServerDeps {
  execCommand: (
    target: CommandTarget,
    id: string,
    args?: unknown,
    fromMain?: boolean,
    source?: CommandSource,
  ) => Promise<CommandResult>
  extensionCommand?: (desc: CommandDescriptor) => ExtensionCommandRun | null
  listCommandsFor: (windowId: string) => CommandDescriptor[]
  getTerminalState: (paneId: string) => TerminalStateSnapshot | undefined
  isSandboxed: (workspaceId: string) => boolean
  windowOfWorkspace?: (workspaceId: string) => string | undefined
  primaryWindow?: () => string | undefined
  byAgent?: <T>(run: () => Promise<T>) => Promise<T>
  reach?: Pick<Reach, 'scriptReach' | 'recordCreated'>
  usage?: Pick<ScriptTokenUsageLog, 'record' | 'connected'>
  journal?: Pick<AgentJournal, 'call'>
  version?: () => string | null
}

let callJournal: ControlServerDeps['journal']

export async function callControlMethod(
  name: string,
  params: unknown,
  ctx: ControlMethodContext,
): Promise<unknown> {
  const began = performance.now()
  const journaled = (bytes: number, code?: string): void => {
    callJournal?.call({
      method: name,
      caller: ctx.identity.kind,
      ms: performance.now() - began,
      bytes,
      code,
    })
  }
  try {
    const m = methods.get(name)
    if (!m) throw new ResponseError(ErrorCodes.MethodNotFound, `unknown-method: ${name}`)
    if (!callerAllowed(ctx.identity, m.targetable ? 'all' : (m.callers ?? 'panes'), m.scripts)) {
      throw new ResponseError(ErrorCodes.InvalidRequest, `not-available-to-${ctx.identity.kind}`)
    }
    if (m.cap) {
      await ensureCaps(ctx.authed, ctx.identity, [m.cap], name, describeParams(name, params))
    }
    const result = await m.handler(params, ctx)
    journaled(callJournal ? answerBytes(result) : 0)
    return result
  } catch (err) {
    journaled(0, verbCode(err instanceof Error ? err.message : ''))
    throw err
  }
}

let server: Server | null = null
let keptServers: Server[] = []
let keptPaths: string[] = []
let handleConnection: ((socket: Socket) => void) | null = null

interface ConnectionSession {
  authed: AuthedConn | null
  disconnect: (() => void) | null
}

type OnCall = <P, R>(
  name: string,
  handler: (params: P, token: CancellationToken) => R | Promise<R>,
) => void

function callsOn(conn: MessageConnection, session: ConnectionSession, deps: ControlServerDeps) {
  const onCall: OnCall = (name, handler) => {
    conn.onRequest(name, async (params, token: CancellationToken) => {
      const tokenId = session.authed?.scriptSession ? session.authed.externalId : undefined
      const usage = tokenId ? deps.usage : undefined
      const method = usage && tokenId ? calledMethod(name, params) : name
      const target = usage && tokenId ? calledTarget(params) : {}
      const began = performance.now()
      const journaled = (bytes: number, code?: string): void => {
        const caller = session.authed ? resolveExternal(session.authed.externalId)?.kind : undefined
        if (!deps.journal || !caller || name === 'hello') return
        deps.journal.call({ method: name, caller, ms: performance.now() - began, bytes, code })
      }
      try {
        const result = await handler(params, token)
        if (usage && tokenId) usage.record(tokenId, { method, target, ...resultOutcome(result) })
        journaled(deps.journal ? answerBytes(result) : 0)
        return result
      } catch (err) {
        const outcome = usage ? errorOutcome(err) : null
        if (usage && tokenId && outcome) usage.record(tokenId, { method, target, ...outcome })
        journaled(0, verbCode(err instanceof Error ? err.message : ''))
        throw err
      }
    })
  }
  return onCall
}

function answerBytes(result: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(result) ?? '')
  } catch {
    return 0
  }
}

function identityOf(session: ConnectionSession) {
  return (callers: ControlCallers, scripts = false): PaneIdentity => {
    const authed = session.authed
    if (!authed) throw unauthenticatedError('call hello first')
    const me = resolveExternal(authed.externalId)
    if (!me || (me.kind === 'script' && me.token !== authed.scriptSession)) {
      throw unauthenticatedError('unknown identity')
    }
    if (me.kind === 'script' && scriptExpired(me.externalId)) {
      throw unauthenticatedError('token-expired: this script token has expired')
    }
    if (!callerAllowed(me, callers, scripts)) {
      throw new ResponseError(ErrorCodes.InvalidRequest, `not-available-to-${me.kind}`)
    }
    return me
  }
}

type RequireIdentity = ReturnType<typeof identityOf>

interface ConnectionCalls {
  conn: MessageConnection
  session: ConnectionSession
  deps: ControlServerDeps
  onCall: OnCall
  requireIdentity: RequireIdentity
}

function registerSessionCalls({ session, deps, onCall, requireIdentity, conn }: ConnectionCalls) {
  conn.onRequest('hello', (params: { token?: string; pid?: unknown } | undefined) => {
    session.disconnect?.()
    session.disconnect = null
    session.authed = authenticate(params ?? {})
    if (!session.authed) throw unauthenticatedError('invalid or missing token')
    if (session.authed.scriptSession && deps.usage) {
      session.disconnect = deps.usage.connected(session.authed.externalId, {
        pid: callerPid(params?.pid),
      })
    }
    const version = deps.version?.()
    return { externalId: session.authed.externalId, ...(version ? { version } : {}) }
  })

  onCall('whoami', (): Record<string, string | undefined> => {
    const me = requireIdentity('all', true)
    if (me.kind === 'extension') return { externalId: me.externalId, extensionId: me.extId }
    if (me.kind === 'script') return { externalId: me.externalId, kind: 'script' }
    return { externalId: me.externalId, paneId: me.paneId, workspaceId: me.workspaceId }
  })

  onCall('command.list', (): CommandDescriptor[] => {
    const me = requireIdentity('panes', true)
    if (me.kind !== 'script') return deps.listCommandsFor(me.windowId)
    const windowId = deps.primaryWindow?.()
    return windowId ? deps.listCommandsFor(windowId).filter((d) => SCRIPT_COMMANDS.has(d.id)) : []
  })
}

function registerCommandExec({ session, deps, onCall, requireIdentity }: ConnectionCalls) {
  onCall(
    'command.exec',
    async (params: {
      id: string
      args?: unknown
      target?: CommandTarget
    }): Promise<CommandResult> => {
      const me = requireIdentity('panes', true)
      if (!session.authed) throw unauthenticatedError('call hello first')
      const script = me.kind === 'script'
      if (script && !SCRIPT_COMMANDS.has(params.id)) {
        throw new ResponseError(ErrorCodes.InvalidRequest, 'not-available-to-script')
      }

      const translated = internalPaneArgs(params.args)
      if (!translated.ok) throw new ResponseError(ErrorCodes.InvalidParams, translated.error)
      const { args, pane } = translated

      const selfTarget: CommandTarget = script
        ? { windowId: deps.primaryWindow?.(), workspaceId: '', paneId: null }
        : { windowId: me.windowId, workspaceId: me.workspaceId, paneId: me.paneId }
      const given = params.target
      let target: CommandTarget = given
        ? {
            ...given,
            windowId: given.windowId ?? deps.windowOfWorkspace?.(given.workspaceId),
          }
        : selfTarget
      if (pane?.workspaceId && pane.workspaceId !== target.workspaceId) {
        if (given) {
          throw new ResponseError(
            ErrorCodes.InvalidParams,
            `bad-request: pane ${pane.externalId} is in workspace ${pane.workspaceId}, not ${given.workspaceId}`,
          )
        }
        target = { windowId: pane.windowId, workspaceId: pane.workspaceId, paneId: null }
      }
      if (script && params.id === 'pane.close' && !target.workspaceId) {
        throw new ResponseError(
          ErrorCodes.InvalidParams,
          'bad-request: pane.close from a script token needs {"paneId": <id from ostia pane list>}',
        )
      }
      if (!script && target.workspaceId !== me.workspaceId && deps.isSandboxed(me.workspaceId)) {
        throw new ResponseError(ErrorCodes.InvalidRequest, SANDBOXED_REFUSAL)
      }
      const desc = deps
        .listCommandsFor(target.windowId ?? me.windowId)
        .find((d) => d.id === params.id)
      const scoped = script
        ? ((await deps.reach?.scriptReach({ identity: me, authed: session.authed })) ?? null)
        : null
      const targetless = desc ? desc.target === 'none' : !target.workspaceId
      const crossTarget = script
        ? !scriptTargetInScope(scoped, params.id, targetless, target, args)
        : target.paneId !== me.paneId ||
          target.windowId !== me.windowId ||
          target.workspaceId !== me.workspaceId
      if (!desc) {
        if (crossTarget && !connHasCap(session.authed, 'all-workspaces')) {
          throw needsElevation('all-workspaces')
        }
        return {
          ok: false,
          error: { code: 'unknown-command', message: `unknown command '${params.id}'` },
        }
      }
      if (script && desc.target !== 'none' && !target.workspaceId) {
        throw new ResponseError(
          ErrorCodes.InvalidParams,
          `bad-request: ${params.id} from a script token needs a workspace: pass --workspace <id> (ostia workspace list)`,
        )
      }
      const asPane = deps.extensionCommand?.(desc) ?? null
      if (asPane && script) {
        throw new ResponseError(ErrorCodes.InvalidRequest, 'not-available-to-script')
      }
      if (asPane && crossTarget) {
        throw new ResponseError(
          ErrorCodes.InvalidParams,
          `bad-request: ${params.id} runs as the calling pane, so it takes no --workspace or paneId`,
        )
      }
      const caps: Capability[] = [
        ...(crossTarget ? (['all-workspaces'] as const) : []),
        ...(asPane
          ? []
          : script
            ? desc.capabilities.filter((cap) => !DEFAULT_CAPABILITIES.includes(cap))
            : desc.capabilities),
      ]
      await ensureCaps(
        session.authed,
        me,
        caps,
        desc.title,
        describeParams(params.id, { command: params.id, args: params.args }),
      )

      if (given?.workspaceId && deps.windowOfWorkspace && !target.windowId) {
        throw new ResponseError(ErrorCodes.InvalidParams, `unknown-workspace: ${given.workspaceId}`)
      }
      const exec = (): Promise<CommandResult> =>
        asPane ? asPane(me, args) : deps.execCommand(target, params.id, args, false, 'control')
      const result = await (deps.byAgent ? deps.byAgent(exec) : exec())
      const createdId = (result.ok ? (result.result as { workspaceId?: unknown }) : undefined)
        ?.workspaceId
      if (scoped && params.id === 'workspace.new' && typeof createdId === 'string') {
        deps.reach?.recordCreated({ identity: me, authed: session.authed }, createdId)
      }
      if (result.ok || !pane) return result
      return {
        ...result,
        error: { ...result.error, message: externalPaneMessage(result.error.message, pane) },
      }
    },
  )
}

function registerPaneCalls({ session, deps, onCall, requireIdentity }: ConnectionCalls) {
  onCall(
    'pane.info',
    async (params?: { paneId?: string }): Promise<TerminalStateSnapshot | null> => {
      const me = requireIdentity('panes', true)
      if (!session.authed) throw unauthenticatedError('call hello first')
      if (!connHasCap(session.authed, 'read-board')) throw needsElevation('read-board')
      const script = me.kind === 'script'
      if (!params?.paneId) {
        if (script) throw new ResponseError(ErrorCodes.InvalidParams, 'bad-request: paneId')
        return deps.getTerminalState(me.paneId) ?? null
      }
      const other = resolveExternal(params.paneId)
      if (other?.kind !== 'pane' || (script && other.manager)) return null
      const scoped = script
        ? await deps.reach?.scriptReach({ identity: me, authed: session.authed })
        : null
      if (scoped && !scoped.covers(other.workspaceId)) return null
      return deps.getTerminalState(other.paneId) ?? null
    },
  )

  onCall('cwd.get', (): { cwd: string | null } => {
    const me = requireIdentity('panes')
    if (session.authed && !connHasCap(session.authed, 'read-board')) {
      throw needsElevation('read-board')
    }
    return { cwd: deps.getTerminalState(me.paneId)?.cwd ?? null }
  })
}

function registerMethodCalls({ session, conn, onCall, requireIdentity }: ConnectionCalls) {
  for (const [name, m] of methods) {
    onCall(name, async (params: unknown, token: CancellationToken) => {
      const caller = requireIdentity(m.targetable ? 'all' : (m.callers ?? 'panes'), m.scripts)
      if (!session.authed) throw unauthenticatedError('call hello first')
      if (m.cap) {
        await ensureCaps(session.authed, caller, [m.cap], name, describeParams(name, params))
      }
      if (caller.kind === 'extension' && m.targetable) {
        const acting = actingPane(session.authed, params)
        return m.handler(acting.params, {
          identity: acting.identity,
          authed: session.authed,
          conn,
          token,
        })
      }
      return m.handler(params, { identity: caller, authed: session.authed, conn, token })
    })
  }
}

function serveConnection(deps: ControlServerDeps, socket: Socket): void {
  const capped = socket.pipe(capIncomingMessages(socket))
  capped.on('error', () => {})
  const reader = new StreamMessageReader(capped)
  reader.onError(() => socket.destroy())
  const conn = createMessageConnection(reader, new StreamMessageWriter(socket))
  const session: ConnectionSession = { authed: null, disconnect: null }
  const calls: ConnectionCalls = {
    conn,
    session,
    deps,
    onCall: callsOn(conn, session, deps),
    requireIdentity: identityOf(session),
  }
  registerSessionCalls(calls)
  registerCommandExec(calls)
  registerPaneCalls(calls)
  registerMethodCalls(calls)

  socket.on('close', () => session.disconnect?.())
  socket.on('error', () => conn.dispose())
  conn.onClose(() => socket.destroy())
  conn.listen()
}

export function registerControlServer(deps: ControlServerDeps, socketPathOverride?: string): void {
  const path = socketPathOverride ?? controlSocketPath()
  callJournal = deps.journal
  try {
    rmSync(path, { force: true })
  } catch {}

  handleConnection = (socket) => serveConnection(deps, socket)
  server = createServer(handleConnection)

  server.on('error', (err) => console.error('[control] socket server error:', err))
  server.listen(path, () => {
    try {
      chmodSync(path, 0o600)
    } catch {}
  })
}

export function listenKeptControlSocket(path: string): void {
  const handle = handleConnection
  if (!handle || keptServers.length > 0) return
  try {
    rmSync(path, { force: true })
  } catch {}
  keptPaths.push(path)
  const kept = createServer(handle)
  kept.on('error', (err) => console.error('[control] kept socket error:', err))
  kept.listen(path, () => {
    try {
      chmodSync(path, 0o600)
    } catch {}
  })
  keptServers.push(kept)
}

export function stopControlServer(): void {
  server?.close()
  server = null
  for (const kept of keptServers) kept.close()
  keptServers = []
  try {
    rmSync(controlSocketPath(), { force: true })
    for (const path of keptPaths) rmSync(path, { force: true })
  } catch {}
  keptPaths = []
}
