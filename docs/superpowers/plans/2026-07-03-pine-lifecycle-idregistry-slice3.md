# Pine Control Plane — Slice 3: Lifecycle Events + ID Registry + Per-Pane Token

> **Fast-mode plan (testing parked by user).** Implementation-focused; unit tests + review are deferred to the parked verification pass (Task #22). Code must still typecheck/lint/build green and preserve existing behavior.

**Goal:** Give `main` a durable, external identity for every pane — `externalId ⇄ {windowId, sessionId, paneId}` + an unguessable `paneToken` — populated by renderer→main lifecycle events, and inject `PINE_*` (incl. the token) into each pty's environment. This is the prerequisite the control socket (Slice 4) authenticates against and targets.

**Architecture:** A pure-ish `idRegistry` in `main` (crypto ids/tokens, no Electron import). A thin `lifecycle` bridge (renderer stores emit `{type, sessionId, paneId}` events; `main` tags `windowId = webContents.id` and updates the registry). Token + ids injected at `pty:attach` spawn env, beside the existing shell-integration env.

## Global Constraints
- Registry lives in `main`; renderer emits via preload only (`contextIsolation`/`sandbox` unchanged). External ids only — never expose renderer counters (`tree.ts:18-21`, `sessionsStore.ts:36-39`).
- `paneToken` = `crypto.randomBytes(32).toString('hex')`; `externalId` = `crypto.randomUUID()`. Injected per-pane so a process in pane X can only prove pane X (pane-scoped-trust posture, spec §6.1).
- Preserve existing behavior: lifecycle emission is additive side-effect; if `window.pine.lifecycle` is absent (older preload during dev) the stores must not throw (guard with optional chaining).
- `npm run typecheck` (only the 4 pre-existing PluginsView errors) + `npm run lint` + `npm run build` green. Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. No new deps (`node:crypto` is built-in). **Tests deferred (Task #22).**

## File Structure
- **Create** `src/main/idRegistry.ts` — the bijection + token store.
- **Modify** `src/shared/types.ts` — `LifecycleEvent` union + `LifecycleApi` on `PineBridge`.
- **Modify** `src/preload/index.ts` — `lifecycle.emit`.
- **Modify** `src/main/index.ts` — `lifecycle:event` handler (updates registry, tags windowId); mint+inject `PINE_PANE_ID`/`PINE_TOKEN`/`PINE_WORKSPACE`/`PINE_SOCKET` at `pty:attach`; drop a window's panes on window `closed`.
- **Modify** `src/renderer/stores/sessionsStore.ts` + `src/renderer/stores/layoutStore.ts` — emit lifecycle events from the relevant actions.

---

## Task 1 (main): `idRegistry.ts` + lifecycle handler + contract + token injection

**Create `src/main/idRegistry.ts`:**
```ts
import { randomBytes, randomUUID } from 'node:crypto'

export interface PaneIdentity {
  externalId: string
  token: string
  windowId: string
  sessionId: string
  paneId: string
}

const byPane = new Map<string, PaneIdentity>() // key: paneId (globally unique per run)
const byExternal = new Map<string, PaneIdentity>()
const byToken = new Map<string, PaneIdentity>()

/** Mint (or return existing) identity for a pane. Idempotent per paneId. */
export function registerPane(input: { windowId: string; sessionId: string; paneId: string }): PaneIdentity {
  const existing = byPane.get(input.paneId)
  if (existing) {
    existing.windowId = input.windowId
    existing.sessionId = input.sessionId
    return existing
  }
  const identity: PaneIdentity = {
    externalId: randomUUID(),
    token: randomBytes(32).toString('hex'),
    ...input,
  }
  byPane.set(identity.paneId, identity)
  byExternal.set(identity.externalId, identity)
  byToken.set(identity.token, identity)
  return identity
}

export function updatePane(paneId: string, patch: Partial<Pick<PaneIdentity, 'windowId' | 'sessionId'>>): void {
  const id = byPane.get(paneId)
  if (id) Object.assign(id, patch)
}

export function removePane(paneId: string): void {
  const id = byPane.get(paneId)
  if (!id) return
  byPane.delete(id.paneId)
  byExternal.delete(id.externalId)
  byToken.delete(id.token)
}

export function removeWindow(windowId: string): void {
  for (const id of [...byPane.values()]) if (id.windowId === windowId) removePane(id.paneId)
}

export function getByPaneId(paneId: string): PaneIdentity | undefined { return byPane.get(paneId) }
export function resolveExternal(externalId: string): PaneIdentity | undefined { return byExternal.get(externalId) }
/** For the Slice 4 control-socket `hello` handshake. */
export function resolveToken(token: string): PaneIdentity | undefined { return byToken.get(token) }
```

**`src/shared/types.ts`** — add:
```ts
export type LifecycleEvent =
  | { type: 'pane-created'; sessionId: string; paneId: string }
  | { type: 'pane-closed'; sessionId: string; paneId: string }
  | { type: 'session-added'; sessionId: string; workDir: string }
  | { type: 'session-closed'; sessionId: string }
  | { type: 'session-activated'; sessionId: string }

export interface LifecycleApi {
  /** Notify main of a UI lifecycle change so it can maintain the pane id/token registry. */
  emit: (event: LifecycleEvent) => void
}
```
Add `lifecycle: LifecycleApi` to `PineBridge`.

**`src/preload/index.ts`** — add to the bridge:
```ts
  lifecycle: {
    emit: (event) => ipcRenderer.send('lifecycle:event', event),
  },
```

**`src/main/index.ts`:**
- Import the registry. In `registerIpc()` add:
```ts
  ipcMain.on('lifecycle:event', (e, event: LifecycleEvent) => {
    const windowId = String(e.sender.id)
    if (event.type === 'pane-created') registerPane({ windowId, sessionId: event.sessionId, paneId: event.paneId })
    else if (event.type === 'pane-closed') removePane(event.paneId)
    else if (event.type === 'session-activated' || event.type === 'session-added') {
      // (session-scoped bookkeeping hook; panes carry sessionId at creation)
    }
  })
```
- In `wireWindow(win)` (or `createWindow`/`createDetachedWindow` `closed` handlers), call `removeWindow(String(win.webContents.id))` on the window's `closed` event so a closed window's identities are pruned.
- At `pty:attach` spawn env (`index.ts:254-260`): mint/lookup and inject:
```ts
    const identity = registerPane({ windowId: String(e.sender.id), sessionId: '', paneId })
    // ...
    env: {
      ...process.env,
      ...integration.env,
      PINE_PANE_ID: identity.externalId,
      PINE_TOKEN: identity.token,
      PINE_WORKSPACE: opts.cwd ?? '',
      PINE_SOCKET: controlSocketPath(), // path the Slice 4 server will bind; a small helper returning `${XDG_RUNTIME_DIR||tmpdir()}/pine-${process.pid}.sock`
    } as Record<string, string>,
```
  (`registerPane` here is idempotent — if the pane already registered via a `pane-created` event, it returns the same identity with the real sessionId; the `sessionId:''` fallback covers a pty that attaches before its event.) Add a `controlSocketPath()` helper (exported, reused by Slice 4).

**Commit:** `feat(control): pane id/token registry + lifecycle bridge + PINE_* env injection`.

---

## Task 2 (renderer): emit lifecycle events from the stores

**`src/renderer/stores/sessionsStore.ts`** — after the state mutation in each action, emit (guarded):
- `addSession`: `window.pine?.lifecycle?.emit({ type: 'session-added', sessionId: session.id, workDir })` and (since `ensure` creates the first pane) let the layout `ensure` emit the pane-created (below).
- `setActive`: `emit({ type: 'session-activated', sessionId: id })`.
- `closeSession`: `emit({ type: 'session-closed', sessionId: id })`.

**`src/renderer/stores/layoutStore.ts`** — emit pane lifecycle from the actions that create/destroy panes:
- `ensure`: after creating the default pane, emit `{ type: 'pane-created', sessionId, paneId: <the new pane's id> }` (read it from the created layout's `firstPaneId`).
- `split`: emit `pane-created` for `newPaneId` (when defined).
- `openFile`: emit `pane-created` if it split a new editor pane (`newPaneId`).
- `closePane`/`removePane`: emit `{ type: 'pane-closed', sessionId, paneId }`.
- `removeSession`: for each pane in the session's tree, emit `pane-closed` (or rely on the main-side `removeWindow`/session cleanup — simplest: emit `pane-closed` per pane; a helper `collectPaneIds(root)` from `tree.ts` if one exists, else walk).

Guard every call with `window.pine?.lifecycle?.emit?.(…)` so tests/older preload don't throw. Keep emissions OUTSIDE the zustand `set` updater (call after `set`) to avoid side-effects during state computation.

**Commit:** `feat(control): emit pane/session lifecycle events from renderer stores`.

---

## Deferred to the parked verification pass (Task #22)
- Unit tests: `idRegistry` (mint idempotency, resolve/remove, token uniqueness, removeWindow) — pure, node-env.
- Review of both tasks; confirm lifecycle events fire on the right transitions (integration/smoke).
- Reconcile `PINE_WORKSPACE` with the true session anchor (currently the pty cwd).
- The Slice-2 fast-follows still open (ghost-owner reap; buffer:'' symmetry).
