/**
 * The LAN control gateway: an `https` server presenting the self-signed cert (`cert.ts`) with a
 * `ws` `WebSocketServer` mounted at `/ws`, plus a plain `POST /pair` handler
 * (`pine-companion/NETWORK-CONTRACT.md` §2–§4). **OFF BY DEFAULT** — nothing here runs until
 * `startGateway` is called explicitly (via `gateway.enable`, `./index.ts`); `src/main/index.ts`
 * must NOT call it from `app.whenReady()` (contract §0: "off by default").
 *
 * Batch 1 wired only `hello` device-token auth on the WS connection (returning `caps` + a
 * `whoami`-style echo). Batch 2 (this revision) adds the full text-channel JSON-RPC control API
 * (contract §7: `session.list`/`pane.list`/`command.list`/`command.exec`/`pane.info`/`cwd.get`/
 * `board.get`) — dispatched via `controlDispatch.ts`'s pure `dispatchGatewayMethod`, wired up
 * here with the actual `ws.send` I/O. The binary PTY stream (contract §6) is still a later batch.
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
import { type GatewayCert, getCert } from './cert'
import { type GatewayControlDeps, dispatchGatewayMethod } from './controlDispatch'
import { type Device, list as listDevices, registerDevice, verifyToken } from './devices'
import { consumeCode } from './pairing'

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

/** Per-connection state: the authed device once `hello` succeeds (null until then). */
interface SocketState {
  device: Device | null
  alive: boolean
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

function handleConnection(ws: WebSocket): void {
  const state: SocketState = { device: null, alive: true }
  sockets.set(ws, state)

  ws.on('pong', () => {
    state.alive = true
  })

  ws.on('message', (data, isBinary) => {
    // Batch 1 only speaks the text/JSON-RPC control channel; the binary PTY stream (contract
    // §6.2) is a later batch — drop binary frames rather than mis-parsing them as JSON.
    if (isBinary) return
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
    handleControlMethod(ws, state.device, msg)
  })

  ws.on('close', () => sockets.delete(ws))
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
