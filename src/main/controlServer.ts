import { chmodSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import {
  ErrorCodes,
  type MessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import type { Capability } from '../shared/capabilities'
import { TARGET_PANE_PARAM } from '../shared/extensions'
import type {
  CommandDescriptor,
  CommandResult,
  CommandTarget,
  TerminalStateSnapshot,
} from '../shared/types'
import { type AuthedConn, authenticate, connHasCap } from './controlAuth'
import { ensureCaps, needsElevation } from './controlElevation'
import { type PaneIdentity, resolveExternal } from './idRegistry'
import { socketPath } from './privateTmp'

export function controlSocketPath(): string {
  return socketPath(process.env.XDG_RUNTIME_DIR || tmpdir(), `pine-${process.pid}.sock`)
}

function unauthenticatedError(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, message)
}

export type ControlCallers = 'panes' | 'extensions' | 'manager' | 'all'

export interface ControlMethodContext {
  identity: PaneIdentity
  authed: AuthedConn
  conn: MessageConnection
}

export interface ControlMethod {
  cap?: Capability
  callers?: ControlCallers
  targetable?: boolean
  handler: (params: unknown, ctx: ControlMethodContext) => unknown | Promise<unknown>
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

function callerAllowed(identity: PaneIdentity, callers: ControlCallers): boolean {
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

export interface ControlServerDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  listCommandsFor: (windowId: string) => CommandDescriptor[]
  getTerminalState: (paneId: string) => TerminalStateSnapshot | undefined
}

let server: Server | null = null

export function registerControlServer(deps: ControlServerDeps, socketPathOverride?: string): void {
  const path = socketPathOverride ?? controlSocketPath()
  try {
    rmSync(path, { force: true })
  } catch {}

  server = createServer((socket) => {
    const conn = createMessageConnection(
      new StreamMessageReader(socket),
      new StreamMessageWriter(socket),
    )
    let authed: AuthedConn | null = null

    const requireIdentity = (callers: ControlCallers): PaneIdentity => {
      if (!authed) throw unauthenticatedError('call hello first')
      const me = resolveExternal(authed.externalId)
      if (!me) throw unauthenticatedError('unknown identity')
      if (!callerAllowed(me, callers)) {
        throw new ResponseError(ErrorCodes.InvalidRequest, `not-available-to-${me.kind}`)
      }
      return me
    }

    conn.onRequest('hello', (params: { token?: string } | undefined) => {
      authed = authenticate(params ?? {})
      if (!authed) throw unauthenticatedError('invalid or missing paneToken')
      return { externalId: authed.externalId }
    })

    conn.onRequest('whoami', (): Record<string, string | undefined> => {
      const me = requireIdentity('all')
      if (me.kind === 'extension') return { externalId: me.externalId, extensionId: me.extId }
      return { externalId: me.externalId, paneId: me.paneId, workspaceId: me.workspaceId }
    })

    conn.onRequest('command.list', (): CommandDescriptor[] => {
      const me = requireIdentity('panes')
      return deps.listCommandsFor(me.windowId)
    })

    conn.onRequest(
      'command.exec',
      async (params: {
        id: string
        args?: unknown
        target?: CommandTarget
      }): Promise<CommandResult> => {
        const me = requireIdentity('panes')
        if (!authed) throw unauthenticatedError('call hello first')

        const selfTarget: CommandTarget = {
          windowId: me.windowId,
          workspaceId: me.workspaceId,
          paneId: me.paneId,
        }
        const target = params.target ?? selfTarget
        const crossTarget =
          target.paneId !== me.paneId ||
          target.windowId !== me.windowId ||
          target.workspaceId !== me.workspaceId

        const desc = deps
          .listCommandsFor(target.windowId ?? me.windowId)
          .find((d) => d.id === params.id)
        if (!desc) {
          if (crossTarget && !connHasCap(authed, 'all-workspaces')) {
            throw needsElevation('all-workspaces')
          }
          return {
            ok: false,
            error: { code: 'unknown-command', message: `unknown command '${params.id}'` },
          }
        }
        const caps: Capability[] = [
          ...(crossTarget ? (['all-workspaces'] as const) : []),
          ...desc.capabilities,
        ]
        await ensureCaps(
          authed,
          me,
          caps,
          desc.title,
          describeParams(params.id, { command: params.id, args: params.args }),
        )

        return deps.execCommand(target, params.id, params.args)
      },
    )

    conn.onRequest('pane.info', (params?: { paneId?: string }): TerminalStateSnapshot | null => {
      const me = requireIdentity('panes')
      if (authed && !connHasCap(authed, 'read-board')) throw needsElevation('read-board')
      if (!params?.paneId) return deps.getTerminalState(me.paneId) ?? null
      const other = resolveExternal(params.paneId)
      return other ? (deps.getTerminalState(other.paneId) ?? null) : null
    })

    conn.onRequest('cwd.get', (): { cwd: string | null } => {
      const me = requireIdentity('panes')
      if (authed && !connHasCap(authed, 'read-board')) throw needsElevation('read-board')
      return { cwd: deps.getTerminalState(me.paneId)?.cwd ?? null }
    })

    for (const [name, m] of methods) {
      conn.onRequest(name, async (params: unknown) => {
        const caller = requireIdentity(m.targetable ? 'all' : (m.callers ?? 'panes'))
        if (!authed) throw unauthenticatedError('call hello first')
        if (m.cap) await ensureCaps(authed, caller, [m.cap], name, describeParams(name, params))
        if (caller.kind === 'extension' && m.targetable) {
          const acting = actingPane(authed, params)
          return m.handler(acting.params, { identity: acting.identity, authed, conn })
        }
        return m.handler(params, { identity: caller, authed, conn })
      })
    }

    socket.on('error', () => conn.dispose())
    conn.onClose(() => socket.destroy())
    conn.listen()
  })

  server.on('error', (err) => console.error('[control] socket server error:', err))
  server.listen(path, () => {
    try {
      chmodSync(path, 0o600)
    } catch {}
  })
}

export function stopControlServer(): void {
  server?.close()
  server = null
  try {
    rmSync(controlSocketPath(), { force: true })
  } catch {}
}
