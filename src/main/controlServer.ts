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
import { type AuthedConn, authenticate } from './controlAuth'

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

let server: Server | null = null

export function registerControlServer(): void {
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

    // command.list / command.exec land in Slice 6 (need the renderer bridge). Not
    // exposed here. Capability-gated methods will call `connHasCap` and throw a
    // typed `needs-elevation` error (spec §6.1) if the connection lacks the cap.

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
