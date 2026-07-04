# Pine Control Plane — Slice 4: Control Socket + Token Auth + Capability Broker

> **Fast-mode plan (testing parked) — EXCEPT the auth/broker, which IS unit-tested (RCE surface).** Everything else's tests deferred to Task #22.

**Goal:** A local Unix-domain-socket JSON-RPC server in `main` that a same-machine caller connects to, proves a per-pane `paneToken` via a mandatory `hello`, and is then granted a capability-scoped connection. No accounts, no network (LAN/phone is a later slice). This is the authenticated seam the `pine` CLI (Slice 5) and command bridge (Slice 6) ride on.

**Architecture:** Reuse the `vscode-jsonrpc` framing already proven in `lsp.ts` (`createMessageConnection` over `StreamMessageReader`/`Writer`), bound to a `net` server on the socket path minted in Slice 3 (`controlSocketPath()`). Auth + capability logic is a **pure, unit-tested module** (`controlAuth` + `capabilityStore`) keyed off Slice 3's `idRegistry` token bijection.

## Global Constraints
- Server in `main` only. Socket file mode `0600`. Auth is **credential-based, not reachability-based** (spec §6): reaching the socket grants nothing; only a valid `paneToken` in `hello` does.
- Posture (spec §6.1, DECIDED): pane-scoped trust. Default caps on auth = `['drive-self','read-board']`; elevated caps off, granted later by explicit user action. Missing cap → typed `needs-elevation` error, never silent.
- `npm run typecheck` (only 4 pre-existing PluginsView errors) / `npm run lint` / `npm run build` green. Commit trailer present. No new deps (`vscode-jsonrpc`, `node:net`/`node:fs` are available).
- **Tests:** unit-test the auth/broker (`controlAuth` + `capabilityStore`) in this slice. Socket wire integration test is parked (Task #22).

## File Structure
- **Create** `src/main/capabilityStore.ts` — per-externalId capability grants (pure).
- **Create** `src/main/capabilityStore.test.ts` — unit tests.
- **Create** `src/main/controlAuth.ts` — `authenticate(hello)` → `{externalId, caps} | null`; `requireCap` helper (pure; depends on idRegistry + capabilityStore).
- **Create** `src/main/controlAuth.test.ts` — unit tests (valid token → caps; bad/absent token → null; cap check pass/deny).
- **Create** `src/main/controlServer.ts` — `net` server + jsonrpc wiring + method dispatch.
- **Modify** `src/main/index.ts` — `registerControlServer()` in `app.whenReady()`; `stopControlServer()` in `before-quit`.

---

## Task 1: capabilityStore (pure, TESTED)
```ts
// src/main/capabilityStore.ts
import { type Capability, DEFAULT_CAPABILITIES } from '../shared/capabilities'

const grants = new Map<string, Set<Capability>>() // key: externalId

/** Ensure an identity has (at least) the default caps; returns its cap set. */
export function initCaps(externalId: string): Set<Capability> {
  let set = grants.get(externalId)
  if (!set) { set = new Set(DEFAULT_CAPABILITIES); grants.set(externalId, set) }
  return set
}
export function grant(externalId: string, cap: Capability): void { initCaps(externalId).add(cap) }
export function revoke(externalId: string, cap: Capability): void { grants.get(externalId)?.delete(cap) }
export function hasCap(externalId: string, cap: Capability): boolean { return grants.get(externalId)?.has(cap) ?? false }
export function dropIdentity(externalId: string): void { grants.delete(externalId) }
```
Tests: initCaps seeds defaults + is idempotent; grant/revoke; hasCap true for default, false for elevated until granted; dropIdentity clears.

## Task 2: controlAuth (pure-ish, TESTED)
```ts
// src/main/controlAuth.ts
import type { Capability } from '../shared/capabilities'
import { resolveToken } from './idRegistry'
import { initCaps, hasCap } from './capabilityStore'

export interface AuthedConn { externalId: string; paneId: string; sessionId: string }

/** Verify a hello token → an authenticated connection identity (or null). Seeds default caps. */
export function authenticate(hello: { token?: unknown }): AuthedConn | null {
  if (typeof hello?.token !== 'string') return null
  const id = resolveToken(hello.token)
  if (!id) return null
  initCaps(id.externalId)
  return { externalId: id.externalId, paneId: id.paneId, sessionId: id.sessionId }
}

/** Broker check: does the connection hold `cap`? */
export function connHasCap(conn: AuthedConn, cap: Capability): boolean {
  return hasCap(conn.externalId, cap)
}
```
Tests (inject a token via `registerPane` from idRegistry): valid token → AuthedConn with the right externalId; non-string/absent/unknown token → null; `connHasCap` true for a default cap, false for an ungranted elevated cap.

## Task 3: controlServer (net + jsonrpc + dispatch; wire tests parked)
```ts
// src/main/controlServer.ts (sketch — implementer fills in)
import { createServer, type Server } from 'node:net'
import { chmodSync, rmSync } from 'node:fs'
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from 'vscode-jsonrpc/node'
import { controlSocketPath } from './index'   // or move the helper here and re-export
import { authenticate, connHasCap, type AuthedConn } from './controlAuth'

let server: Server | null = null

export function registerControlServer(): void {
  const path = controlSocketPath()
  try { rmSync(path, { force: true }) } catch {}
  server = createServer((socket) => {
    const conn = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket))
    let authed: AuthedConn | null = null

    conn.onRequest('hello', (params: { token?: string }) => {
      authed = authenticate(params ?? {})
      if (!authed) throw jsonRpcError('unauthenticated', 'invalid or missing paneToken')
      return { externalId: authed.externalId }
    })
    conn.onRequest('whoami', () => {
      if (!authed) throw jsonRpcError('unauthenticated', 'call hello first')
      return { externalId: authed.externalId, paneId: authed.paneId, sessionId: authed.sessionId }
    })
    // command.list / command.exec land in Slice 6 (need the renderer bridge). Not exposed here.

    socket.on('error', () => conn.dispose())
    conn.onClose(() => socket.destroy())
    conn.listen()
  })
  server.listen(path, () => { try { chmodSync(path, 0o600) } catch {} })
}

export function stopControlServer(): void {
  server?.close()
  server = null
  try { rmSync(controlSocketPath(), { force: true }) } catch {}
}
```
- Add a small `jsonRpcError(code, message)` (a `ResponseError` from `vscode-jsonrpc`, or a plain object with `{code, message}` — match how `lsp.ts` surfaces errors). Every non-`hello` method checks `authed` first; capability-gated methods (Slice 6) will call `connHasCap` and throw a `needs-elevation` error if missing.
- **Note the `controlSocketPath` import cycle risk:** it currently lives in `index.ts` and `index.ts` will import `controlServer`. To avoid a cycle, MOVE `controlSocketPath()` into `controlServer.ts` (export it) and have `index.ts` (Slice 3's env injection) import it from there instead. Update the Slice-3 injection import accordingly.

## Task 4: wire into index.ts
- `import { registerControlServer, stopControlServer } from './controlServer'`
- In `app.whenReady()` (`index.ts:336-341`), add `registerControlServer()` after the other `registerX()`.
- In `before-quit` (`index.ts:348-357`), add `stopControlServer()`.
- Repoint the Slice-3 `PINE_SOCKET` injection to import `controlSocketPath` from `./controlServer`.
- Verify typecheck/lint/build.

**Commit(s):** `feat(control): capability store + token-auth broker (tested)` then `feat(control): local control socket server (jsonrpc over unix socket) + hello auth`.

## Deferred (Task #22)
- Socket wire integration test (spin server on a temp socket, connect a client, assert hello/whoami + unauth rejection + 0600 perms).
- Single-instance lock (`app.requestSingleInstanceLock`) so a 2nd instance doesn't `EADDRINUSE` the socket — spec Seam G; land with/before Slice 5 CLI.
- Rate limiting + audit log.
