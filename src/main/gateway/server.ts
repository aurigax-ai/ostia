/**
 * The LAN control gateway: an `https` server presenting the self-signed cert (`cert.ts`) with a
 * `ws` `WebSocketServer` mounted at `/ws`, plus a plain `POST /pair` handler
 * (`pine-companion/NETWORK-CONTRACT.md` §2–§4). **OFF BY DEFAULT** — nothing here runs until
 * `startGateway` is called explicitly (via `gateway.enable`, `./index.ts`); `src/main/index.ts`
 * must NOT call it from `app.whenReady()` (contract §0: "off by default").
 *
 * Batch 1 wired only `hello` device-token auth on the WS connection (returning `caps` + a
 * `whoami`-style echo). Batch 2 adds the full text-channel JSON-RPC control API (contract §7:
 * `session.list`/`pane.list`/`command.list`/`command.exec`/`pane.info`/`cwd.get`/`board.get`) —
 * dispatched via `controlDispatch.ts`'s pure `dispatchGatewayMethod`, wired up here with the
 * actual `ws.send` I/O. Batch 3 (this revision) adds the binary PTY stream (contract §6):
 * `pty.attach`/`pty.detach` are handled INLINE here (not through `dispatchGatewayMethod` — see
 * `GatewayControlDeps`'s docstring for why), and incoming binary WS frames (`0x02` input /
 * `0x03` resize) are parsed in the `message` handler below instead of being dropped.
 *
 * Origin/host posture: this server has no legitimate browser-page caller (it serves no HTML —
 * only `/pair` and `/ws`), so ANY `Origin` header at all is treated as a hostile cross-origin
 * request (a real browser always sets one; the companion app and `curl`-style native clients
 * never do) and rejected outright — this is the "Origin/Host checks" contract §2 calls for.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { type Server as HttpsServer, createServer as createHttpsServer } from 'node:https'
import { app } from 'electron'
import { type WebSocket, WebSocketServer } from 'ws'
import { resolveExternal } from '../idRegistry'
import { type GatewayCert, getCert } from './cert'
import { type GatewayControlDeps, dispatchGatewayMethod } from './controlDispatch'
import { type Device, list as listDevices, registerDevice, verifyToken } from './devices'
import { consumeCode } from './pairing'

/** Binary WS frame type bytes (contract §6.2): `[1-byte type][payload]`. */
const FRAME_PTY_OUTPUT = 0x01 // server -> client: raw pty output bytes
const FRAME_PTY_INPUT = 0x02 // client -> server: raw input bytes (owner + `input` cap only)
const FRAME_PTY_RESIZE = 0x03 // client -> server: JSON `{cols,rows}`

export interface GatewayStartOptions {
  host?: string
  port?: number
}

export interface GatewayStartResult {
  host: string
  port: number
  fingerprint: string
}

export interface GatewayStatus {
  running: boolean
  host: string | null
  port: number | null
  fingerprint: string | null
  deviceCount: number
}

/** Contract §2: "default suggestion 8722." */
const DEFAULT_PORT = 8722
/** Every interface, unless the caller (or a future settings-driven default) picks one. */
const DEFAULT_HOST = '0.0.0.0'
/** Heartbeat cadence (contract §6.3) — keeps idle LAN connections from going silently stale. */
const HEARTBEAT_MS = 15_000

let httpsServer: HttpsServer | null = null
let wss: WebSocketServer | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null
let boundHost: string | null = null
let boundPort: number | null = null
let currentFingerprint: string | null = null

/**
 * A socket's currently-attached PTY stream (contract §6) — v1 keeps it simple, one attached
 * pane per WS (the contract's §6.2 multiplexing note), so a socket needs at most one of these
 * at a time. `canWrite` is decided once, at `pty.attach` time (role `'owner'` AND the device
 * holds the `input` cap) — the binary-frame handler consults it rather than re-deriving it.
 */
interface PtyAttachment {
  /** Main's INTERNAL pane id (already resolved from the phone's external id). */
  rendererPaneId: string
  canWrite: boolean
  detach: () => void
}

/** Per-connection state: the authed device once `hello` succeeds (null until then). */
interface SocketState {
  device: Device | null
  alive: boolean
  ptyAttachment: PtyAttachment | null
}
const sockets = new Map<WebSocket, SocketState>()

/**
 * The phone control API's backing deps (`execCommand`/`listPanes`/`kanbanGet`/...), configured
 * once from `index.ts` alongside `registerControlServer` — independent of whether the gateway is
 * actually running (deps don't change across `gateway.enable`/`disable` restarts). Null until
 * `configureGatewayControl` runs; every authed method call fails closed until then rather than
 * dereferencing a missing dep.
 */
let controlDeps: GatewayControlDeps | null = null

/** Wire the phone-facing control API's deps (batch 2). Call once at `app.whenReady()`. */
export function configureGatewayControl(deps: GatewayControlDeps): void {
  controlDeps = deps
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): string {
  const error: { code: number; message: string; data?: unknown } = { code, message }
  if (data !== undefined) error.data = data
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error })
}

/** A real browser always sets `Origin`; the companion app / `curl`-style clients never do. */
function hasBrowserOrigin(origin: string | undefined): boolean {
  return typeof origin === 'string' && origin.length > 0
}

/** Read a bounded request body (pairing bodies are tiny) and `JSON.parse` it; null on any failure. */
function readJsonBody(req: IncomingMessage, maxBytes = 16_384): Promise<unknown> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

/** `POST /pair` (contract §3 steps 3–4): redeem a pairing code, register the device, hand back a token. */
async function handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as {
    pairCode?: unknown
    device?: { name?: unknown; pubkey?: unknown }
  } | null
  const pairCode = body?.pairCode
  const device = body?.device
  if (
    typeof pairCode !== 'string' ||
    !device ||
    typeof device.name !== 'string' ||
    typeof device.pubkey !== 'string'
  ) {
    sendJson(res, 400, {
      error: 'bad-request',
      message: 'expected { pairCode, device: { name, pubkey } }',
    })
    return
  }
  if (!consumeCode(pairCode)) {
    sendJson(res, 401, { error: 'invalid-pair-code' })
    return
  }
  const { deviceId, token, caps } = registerDevice({ name: device.name, pubkey: device.pubkey })
  sendJson(res, 200, { deviceId, deviceToken: token, caps, expiresAt: null })
}

/** Every non-`/pair` HTTP request gets a flat 404 — no other surface is exposed over plain HTTP. */
function requestHandler(req: IncomingMessage, res: ServerResponse): void {
  if (hasBrowserOrigin(req.headers.origin)) {
    sendJson(res, 403, { error: 'origin-not-allowed' })
    return
  }
  if (req.method === 'POST' && req.url === '/pair') {
    handlePair(req, res).catch(() => sendJson(res, 500, { error: 'internal-error' }))
    return
  }
  sendJson(res, 404, { error: 'not-found' })
}

/** `hello` (contract §4): verify `deviceToken`, reply with `caps` + a desktop echo, or reject + close. */
function handleHello(
  ws: WebSocket,
  state: SocketState,
  msg: { id?: unknown; params?: unknown },
): void {
  const params = (msg.params ?? {}) as { deviceToken?: unknown }
  const device = typeof params.deviceToken === 'string' ? verifyToken(params.deviceToken) : null
  if (!device) {
    ws.send(rpcError(msg.id, -32001, 'unauthenticated'))
    ws.close(4001, 'unauthenticated')
    return
  }
  state.device = device
  ws.send(
    rpcResult(msg.id, {
      deviceId: device.deviceId,
      caps: device.caps,
      desktop: { name: 'pine', version: app.getVersion() },
    }),
  )
}

/** Echoes the authed device's identity/caps back — handy for a client to confirm its session is
 *  still alive without re-`hello`ing (`device.caps` in the contract serves the same "refresh
 *  after an elevation grant" purpose; this predates that and is kept for compatibility). */
function handleWhoami(ws: WebSocket, state: SocketState, msg: { id?: unknown }): void {
  if (!state.device) {
    ws.send(rpcError(msg.id, -32001, 'unauthenticated'))
    return
  }
  ws.send(rpcResult(msg.id, { deviceId: state.device.deviceId, caps: state.device.caps }))
}

/**
 * Every OTHER authed method (contract §7: `session.list`/`pane.list`/`command.list`/
 * `command.exec`/`pane.info`/`cwd.get`/`board.get`) — resolved by the pure
 * `dispatchGatewayMethod` (device-cap gating + target resolution live there, unit-tested without
 * `ws`/Electron) and translated into a JSON-RPC response frame here. Fire-and-forget from the
 * caller's point of view (the `message` handler isn't `async`) — `.catch` below guarantees a
 * response frame even if a dep throws (e.g. `execCommand` rejecting), rather than leaving the
 * phone's pending request hanging forever.
 */
function handleControlMethod(
  ws: WebSocket,
  device: Device,
  msg: { id?: unknown; method?: unknown; params?: unknown },
): void {
  if (!controlDeps) {
    ws.send(rpcError(msg.id, -32603, 'gateway control API not configured'))
    return
  }
  dispatchGatewayMethod(String(msg.method), msg.params, device.caps, controlDeps)
    .then((outcome) => {
      if (outcome.ok) ws.send(rpcResult(msg.id, outcome.result))
      else ws.send(rpcError(msg.id, outcome.code, outcome.message, outcome.data))
    })
    .catch((err) => {
      ws.send(rpcError(msg.id, -32603, err instanceof Error ? err.message : 'internal error'))
    })
}

/** Frame a `0x01` server->client PTY-output binary WS frame (contract §6.2): `[type][utf8 data]`. */
function ptyOutputFrame(data: string): Buffer {
  return Buffer.concat([Buffer.from([FRAME_PTY_OUTPUT]), Buffer.from(data, 'utf8')])
}

/**
 * `pty.attach` (contract §6.1): resolve the phone's external `paneId` (from `pane.list`) to
 * main's internal renderer-pane id via `idRegistry`, then subscribe this socket on that pane's
 * live `PtySession` through the `attachPhoneObserver` dep, streaming output back as binary
 * `0x01` frames. Handled INLINE (not through `dispatchGatewayMethod`) because it needs a live
 * `sendData` bound to this exact `ws` plus per-socket detach tracking — see
 * `GatewayControlDeps`'s docstring.
 *
 * Read-only (`observer`) by default; `role:'owner'` is only honored when the device also holds
 * the phone-facing `input` cap — otherwise it's silently downgraded to `observer` rather than
 * rejected outright (same degrade-gracefully posture as the rest of the gateway). A second
 * `pty.attach` on the same socket replaces the first (v1: one attached pane's stream per WS,
 * per the contract's §6.2 multiplexing note) — the old subscription is detached first so it
 * never leaks.
 */
function handlePtyAttach(
  ws: WebSocket,
  state: SocketState,
  device: Device,
  msg: { id?: unknown; params?: unknown },
): void {
  if (!controlDeps) {
    ws.send(rpcError(msg.id, -32603, 'gateway control API not configured'))
    return
  }
  if (!device.caps.includes('read')) {
    ws.send(rpcError(msg.id, -32003, 'needs-elevation', { cap: 'read' }))
    return
  }
  const p = (msg.params ?? {}) as { paneId?: unknown; role?: unknown; sinceCursor?: unknown }
  if (typeof p.paneId !== 'string' || !p.paneId) {
    ws.send(rpcError(msg.id, -32602, 'missing paneId'))
    return
  }
  const identity = resolveExternal(p.paneId)
  if (!identity) {
    ws.send(rpcError(msg.id, -32602, 'unknown paneId'))
    return
  }
  const wantsOwner = p.role === 'owner'
  const role: 'observer' | 'owner' =
    wantsOwner && device.caps.includes('input') ? 'owner' : 'observer'
  const sinceCursor = typeof p.sinceCursor === 'number' ? p.sinceCursor : 0

  // Replace any prior attachment on this socket rather than leaking its subscriber.
  state.ptyAttachment?.detach()
  state.ptyAttachment = null

  const attached = controlDeps.attachPhoneObserver(identity.paneId, {
    sinceCursor,
    role,
    sendData: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(ptyOutputFrame(data))
    },
  })
  if (!attached) {
    ws.send(rpcError(msg.id, -32602, 'unknown pane (no live pty)'))
    return
  }
  state.ptyAttachment = {
    rendererPaneId: identity.paneId,
    canWrite: role === 'owner',
    detach: attached.detach,
  }
  ws.send(
    rpcResult(msg.id, {
      cursor: attached.cursor,
      dropped: attached.dropped,
      cols: attached.cols,
      rows: attached.rows,
    }),
  )
}

/**
 * `pty.detach` (contract §6.1): stop streaming to this socket. `paneId` is accepted for
 * contract-shape parity but v1 tracks a single attachment per socket — a detach naming a pane
 * that isn't the currently-attached one is a no-op (there's nothing else to drop), not an error.
 */
function handlePtyDetach(
  ws: WebSocket,
  state: SocketState,
  msg: { id?: unknown; params?: unknown },
): void {
  const p = (msg.params ?? {}) as { paneId?: unknown }
  if (state.ptyAttachment && typeof p.paneId === 'string') {
    const identity = resolveExternal(p.paneId)
    if (identity && identity.paneId !== state.ptyAttachment.rendererPaneId) {
      ws.send(rpcResult(msg.id, { ok: true }))
      return
    }
  }
  state.ptyAttachment?.detach()
  state.ptyAttachment = null
  ws.send(rpcResult(msg.id, { ok: true }))
}

/**
 * Incoming BINARY WS frames from the phone (contract §6.2): `[1-byte type][payload]`.
 * - `0x02` input bytes: only honored if this socket is attached as `owner` with the `input`
 *   cap (`state.ptyAttachment.canWrite`) — otherwise dropped + a `-32003` notification, per the
 *   contract's "otherwise dropped + a -32003 event".
 * - `0x03` resize: `{cols,rows}` JSON payload → `ptyResize`. NOT gated on `canWrite` — resizing
 *   only reshapes the shared view (SIGWINCH), it can't inject content, and an `observer` phone
 *   legitimately wants the mirrored pty to fit its own screen.
 * - Anything else (including a frame with no active attachment) is ignored, per "ignore unknown
 *   types".
 */
function handleBinaryFrame(ws: WebSocket, state: SocketState, data: Buffer): void {
  if (!state.device || !controlDeps || data.length < 1) return
  const type = data[0]
  const payload = data.subarray(1)
  const attachment = state.ptyAttachment

  if (type === FRAME_PTY_INPUT) {
    if (!attachment?.canWrite) {
      ws.send(rpcError(null, -32003, 'needs-elevation', { cap: 'input' }))
      return
    }
    controlDeps.ptyWrite(attachment.rendererPaneId, payload.toString('utf8'))
    return
  }

  if (type === FRAME_PTY_RESIZE) {
    if (!attachment) return
    let resize: { cols?: unknown; rows?: unknown }
    try {
      resize = JSON.parse(payload.toString('utf8'))
    } catch {
      return
    }
    if (typeof resize.cols === 'number' && typeof resize.rows === 'number') {
      controlDeps.ptyResize(attachment.rendererPaneId, resize.cols, resize.rows)
    }
    return
  }

  // Unknown type byte — ignore (contract §6.2).
}

function handleConnection(ws: WebSocket): void {
  const state: SocketState = { device: null, alive: true, ptyAttachment: null }
  sockets.set(ws, state)

  ws.on('pong', () => {
    state.alive = true
  })

  ws.on('message', (data, isBinary) => {
    // Binary frames (contract §6.2) are the PTY input/resize channel — never JSON, handled
    // separately from the text/JSON-RPC control channel below.
    if (isBinary) {
      handleBinaryFrame(ws, state, data as Buffer)
      return
    }
    let msg: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
    try {
      msg = JSON.parse(data.toString('utf8'))
    } catch {
      ws.send(rpcError(null, -32700, 'parse error'))
      return
    }
    if (msg.method === 'hello') {
      handleHello(ws, state, msg)
      return
    }
    if (!state.device) {
      ws.send(rpcError(msg.id, -32001, 'unauthenticated'))
      ws.close(4001, 'unauthenticated')
      return
    }
    if (msg.method === 'whoami') {
      handleWhoami(ws, state, msg)
      return
    }
    if (msg.method === 'pty.attach') {
      handlePtyAttach(ws, state, state.device, msg)
      return
    }
    if (msg.method === 'pty.detach') {
      handlePtyDetach(ws, state, msg)
      return
    }
    handleControlMethod(ws, state.device, msg)
  })

  ws.on('close', () => {
    // Mirror the ghost-owner care already in the pty code (`ptySession.ts`'s
    // `removeSubscriber`/`onNoOwners`) — a dropped connection must not leak a subscriber that
    // outlives it, whether the socket closed cleanly (`pty.detach`) or not.
    state.ptyAttachment?.detach()
    state.ptyAttachment = null
    sockets.delete(ws)
  })
}

/** Ping every open connection; terminate any that didn't pong since the last sweep (contract §6.3). */
function startHeartbeat(): void {
  heartbeat = setInterval(() => {
    for (const [ws, state] of sockets) {
      if (!state.alive) {
        ws.terminate()
        continue
      }
      state.alive = false
      ws.ping()
    }
  }, HEARTBEAT_MS)
}

/**
 * Start the gateway: load/generate the TLS cert, bind `https` + the `/ws` WebSocketServer to
 * `host:port`. Idempotent — restarts (stop then start) if already running, so re-calling
 * `gateway.enable` with new options rebinds cleanly instead of throwing `EADDRINUSE`.
 */
export async function startGateway(options: GatewayStartOptions = {}): Promise<GatewayStartResult> {
  if (httpsServer) await stopGateway()

  const cert: GatewayCert = await getCert()
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT

  const server = createHttpsServer({ cert: cert.cert, key: cert.key }, requestHandler)
  const wsServer = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info: { origin: string }) => !hasBrowserOrigin(info.origin),
  })
  wsServer.on('connection', handleConnection)
  server.on('error', (err) => console.error('[gateway] server error:', err))

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  httpsServer = server
  wss = wsServer
  boundHost = host
  boundPort = port
  currentFingerprint = cert.fingerprint
  startHeartbeat()

  return { host, port, fingerprint: cert.fingerprint }
}

/** Stop the gateway (closes every open connection) and reset status to "not running". */
export async function stopGateway(): Promise<void> {
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
  for (const ws of sockets.keys()) ws.terminate()
  sockets.clear()

  const wssToClose = wss
  const httpsToClose = httpsServer
  wss = null
  httpsServer = null
  boundHost = null
  boundPort = null
  currentFingerprint = null

  // `wss.close()` only unregisters the `/ws` upgrade listener (it doesn't own the underlying
  // `httpsServer`, which was handed in via the `server` option) — the https server needs its
  // own `close()` to actually stop listening. Every socket is already terminated above, so
  // neither call is waiting on an open connection to drain.
  if (wssToClose) await new Promise<void>((resolve) => wssToClose.close(() => resolve()))
  if (httpsToClose) await new Promise<void>((resolve) => httpsToClose.close(() => resolve()))
}

export function gatewayStatus(): GatewayStatus {
  return {
    running: httpsServer !== null,
    host: boundHost,
    port: boundPort,
    fingerprint: currentFingerprint,
    deviceCount: listDevices().length,
  }
}
