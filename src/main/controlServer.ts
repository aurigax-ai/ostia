/**
 * Local control-plane socket (Slice 4, spec §6). A Unix-domain-socket JSON-RPC
 * server, bound in `main` only, that a same-machine caller (the `pine` CLI —
 * Slice 5 — or the command bridge — Slice 6) dials into. Reaching the socket
 * grants nothing by itself (credential-based, not reachability-based auth):
 * every connection must prove a per-pane `paneToken` via `hello` before any
 * other method is served. Reuses the `vscode-jsonrpc` framing already proven
 * in `lsp.ts` (`createMessageConnection` over `StreamMessageReader`/`Writer`),
 * but bound to a `net.Server` instead of a child process's stdio.
 */
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
import { resolveExternal } from './idRegistry'

/**
 * Filesystem path of this app instance's control socket. Panes are given it via
 * `PINE_SOCKET` so external processes can dial home. One per running app instance
 * (`process.pid`-scoped), under `$XDG_RUNTIME_DIR` (or the OS temp dir as a
 * fallback, e.g. on macOS/Windows where that var is unset). Lives here (not
 * `index.ts`) so `index.ts` can import this module without an import cycle.
 */
export function controlSocketPath(): string {
  return join(process.env.XDG_RUNTIME_DIR || tmpdir(), `pine-${process.pid}.sock`)
}

/** A JSON-RPC error for a connection that hasn't (yet, or successfully) authenticated. */
function unauthenticatedError(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, message)
}

/** A JSON-RPC error for a connection that lacks an elevated capability it needs. */
function needsElevation(cap: Capability): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, `needs-elevation: ${cap}`)
}

/**
 * `index.ts` (window registry + command bridge) imports this module, so this module must
 * NOT import `index.ts` back — that would be an import cycle. Instead `index.ts` hands
 * over `execCommand`/`listCommandsFor` at `app.whenReady()` via `registerControlServer`.
 */
export interface ControlServerDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  listCommandsFor: (windowId: string) => CommandDescriptor[]
  /** Slice 7 read-model: the latest mirrored terminal-state snapshot for a pane. */
  getTerminalState: (paneId: string) => TerminalStateSnapshot | undefined
}

let server: Server | null = null

export function registerControlServer(deps: ControlServerDeps): void {
  const path = controlSocketPath()
  try {
    rmSync(path, { force: true })
  } catch {
    // no stale socket to remove
  }

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

        // Cross-pane gate: acting on another pane (or window) needs 'workspace-wide'.
        if (target.paneId !== me.paneId || target.windowId !== me.windowId) {
          if (!connHasCap(authed, 'workspace-wide')) throw needsElevation('workspace-wide')
        }

        const desc = deps.listCommandsFor(me.windowId).find((d) => d.id === params.id)
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

    // Slice 7: "what is pane X doing" — read-only, gated on 'read-board' (a DEFAULT
    // capability every pane holds), for the same explicit-gate posture as everything
    // else on the broker. Defaults to the caller's own pane; `{ paneId }` reads another
    // pane's mirrored state (same trust posture as reading `command.list`, which is
    // scoped to the caller's window either way).
    conn.onRequest('pane.info', (params?: { paneId?: string }): TerminalStateSnapshot | null => {
      if (!authed) throw unauthenticatedError('call hello first')
      if (!connHasCap(authed, 'read-board')) throw needsElevation('read-board')
      const me = resolveExternal(authed.externalId)
      if (!me) throw unauthenticatedError('unknown identity')
      return deps.getTerminalState(params?.paneId ?? me.paneId) ?? null
    })

    conn.onRequest('cwd.get', (): { cwd: string | null } => {
      if (!authed) throw unauthenticatedError('call hello first')
      if (!connHasCap(authed, 'read-board')) throw needsElevation('read-board')
      const me = resolveExternal(authed.externalId)
      if (!me) throw unauthenticatedError('unknown identity')
      return { cwd: deps.getTerminalState(me.paneId)?.cwd ?? null }
    })

    socket.on('error', () => conn.dispose())
    conn.onClose(() => socket.destroy())
    conn.listen()
  })

  server.on('error', (err) => console.error('[control] socket server error:', err))
  server.listen(path, () => {
    try {
      chmodSync(path, 0o600)
    } catch {
      // best-effort permission tightening
    }
  })
}

export function stopControlServer(): void {
  server?.close()
  server = null
  try {
    rmSync(controlSocketPath(), { force: true })
  } catch {
    // already gone
  }
}
