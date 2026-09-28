import { chmodSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ErrorCodes,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import type { Capability } from '../shared/capabilities'
import type {
  CommandDescriptor,
  CommandResult,
  CommandTarget,
  TerminalStateSnapshot,
} from '../shared/types'
import { type AuthedConn, authenticate, connHasCap } from './controlAuth'
import { type PaneIdentity, resolveExternal } from './idRegistry'

export function controlSocketPath(): string {
  return join(process.env.XDG_RUNTIME_DIR || tmpdir(), `pine-${process.pid}.sock`)
}

function unauthenticatedError(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, message)
}

function needsElevation(cap: Capability): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, `needs-elevation: ${cap}`)
}

export interface ControlMethod {
  cap?: Capability
  handler: (
    params: unknown,
    ctx: { identity: PaneIdentity; authed: AuthedConn },
  ) => unknown | Promise<unknown>
}

const methods = new Map<string, ControlMethod>()

export function registerControlMethod(name: string, method: ControlMethod): void {
  if (methods.has(name)) throw new Error(`control method already registered: ${name}`)
  methods.set(name, method)
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

    conn.onRequest('hello', (params: { token?: string } | undefined) => {
      authed = authenticate(params ?? {})
      if (!authed) throw unauthenticatedError('invalid or missing paneToken')
      return { externalId: authed.externalId }
    })

    conn.onRequest('whoami', () => {
      if (!authed) throw unauthenticatedError('call hello first')
      return { externalId: authed.externalId, paneId: authed.paneId, sessionId: authed.sessionId }
    })

    conn.onRequest('command.list', (): CommandDescriptor[] => {
      if (!authed) throw unauthenticatedError('call hello first')
      const me = resolveExternal(authed.externalId)
      if (!me) throw unauthenticatedError('unknown identity')
      return deps.listCommandsFor(me.windowId)
    })

    conn.onRequest(
      'command.exec',
      (params: { id: string; args?: unknown; target?: CommandTarget }): Promise<CommandResult> => {
        if (!authed) throw unauthenticatedError('call hello first')
        const me = resolveExternal(authed.externalId)
        if (!me) throw unauthenticatedError('unknown identity')

        const selfTarget: CommandTarget = {
          windowId: me.windowId,
          sessionId: me.sessionId,
          paneId: me.paneId,
        }
        const target = params.target ?? selfTarget

        if (
          target.paneId !== me.paneId ||
          target.windowId !== me.windowId ||
          target.sessionId !== me.sessionId
        ) {
          if (!connHasCap(authed, 'workspace-wide')) throw needsElevation('workspace-wide')
        }

        const desc = deps
          .listCommandsFor(target.windowId ?? me.windowId)
          .find((d) => d.id === params.id)
        if (!desc) {
          return Promise.resolve({
            ok: false,
            error: { code: 'unknown-command', message: `unknown command '${params.id}'` },
          })
        }
        for (const cap of desc.capabilities) {
          if (!connHasCap(authed, cap)) throw needsElevation(cap)
        }

        return deps.execCommand(target, params.id, params.args)
      },
    )

    conn.onRequest('pane.info', (params?: { paneId?: string }): TerminalStateSnapshot | null => {
      if (!authed) throw unauthenticatedError('call hello first')
      if (!connHasCap(authed, 'read-board')) throw needsElevation('read-board')
      const me = resolveExternal(authed.externalId)
      if (!me) throw unauthenticatedError('unknown identity')
      if (!params?.paneId) return deps.getTerminalState(me.paneId) ?? null
      const other = resolveExternal(params.paneId)
      return other ? (deps.getTerminalState(other.paneId) ?? null) : null
    })

    conn.onRequest('cwd.get', (): { cwd: string | null } => {
      if (!authed) throw unauthenticatedError('call hello first')
      if (!connHasCap(authed, 'read-board')) throw needsElevation('read-board')
      const me = resolveExternal(authed.externalId)
      if (!me) throw unauthenticatedError('unknown identity')
      return { cwd: deps.getTerminalState(me.paneId)?.cwd ?? null }
    })

    for (const [name, m] of methods) {
      conn.onRequest(name, async (params: unknown) => {
        if (!authed) throw unauthenticatedError('call hello first')
        if (m.cap && !connHasCap(authed, m.cap)) throw needsElevation(m.cap)
        const identity = resolveExternal(authed.externalId)
        if (!identity) throw unauthenticatedError('unknown identity')
        return m.handler(params, { identity, authed })
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
