# Pine Control Plane (Phase A-MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Pine a control-plane spine — a `pine` CLI that drives the running app over an authenticated local socket, so an agent in a pane can split/focus/run in *its own* pane and introspect the app's commands.

**Architecture:** A control server in the Electron **main** process (`net` Unix socket, `vscode-jsonrpc` framing — same as `lsp.ts`) exposes the existing renderer **command registry** to external callers. Callers prove a per-pane token (injected at pty spawn) in a `hello` handshake; the server checks capabilities, then round-trips `command.exec` to the renderer. Everything rides on the command registry, which is upgraded first to carry arg/result/capability/target schemas.

**Tech Stack:** TypeScript, Electron (main/preload/renderer, `contextIsolation:true` `sandbox:true` `nodeIntegration:false`), zustand, node-pty, `vscode-jsonrpc` (already a dep), Vitest (`environment: 'node'`).

## Global Constraints

- **Renderer has no Node access** — the control server, socket, and any `net`/`fs` work live in **main** (`src/main/`). Renderer reaches main only via the preload `contextBridge` (`src/preload/index.ts`) and typed `PineBridge` (`src/shared/types.ts`).
- **Tests run in `environment: 'node'`** (`vitest.config.ts`), `include: ['src/**/*.test.ts']`. **No jsdom/DOM is installed** — test pure logic (registry, stores, protocol, id-registry, broker), not React components. Model existing `src/renderer/layout/tree.test.ts`.
- **Security posture (DECIDED): pane-scoped trust.** A process inside pane X is trusted as pane X. Default capabilities = `['drive-self','read-board']`. Elevated caps (`send-other-pane`, `kill-pane`, `workspace-wide`, `shell`, `destructive`, `phone`) are **off by default**, granted per-pane by explicit user action. A missing cap returns a typed `needs-elevation` error — never a silent success or no-op.
- **Verify every change:** `npm run typecheck` (both tsconfigs) and `npm run lint` must pass before each commit. Native `node-pty` may be unavailable (`loadPty()` returns null, `src/main/index.ts:23-34`) — never assume a live pty.
- **Commit style:** conventional commits; end each message with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.
- **No new runtime deps in Slice 1** (types only). ULID/SQLite arrive in later slices.
- **External ids only:** never expose the renderer's internal `pane-N`/`sN` counters (`layout/tree.ts:11`, `sessionsStore.ts:35`) as an API surface — the id registry (Slice 3) mints external ULIDs.

---

## A-MVP slice roadmap

Seven ordered slices; each produces working, testable software and is its own plan-grade unit. **This document fully details Slice 1.** Slices 2–7 are scoped here and expanded to the same TDD depth just-in-time (reading their target files first) so code blocks stay accurate rather than invented.

| # | Slice | Deliverable | Exit test |
|---|-------|-------------|-----------|
| **1** | **Command contract upgrade** (spec A.0.1) | `CommandDef` carries `argsSchema`/`resultSchema`/`capabilities`/`target`; `exec` returns `CommandResult`; `describe()` gives stable serialization. | `registry.test.ts` green; app still builds; `describe()` sorted + defaults applied. |
| 2 | PTY multi-subscriber refactor (A.0.2) + IPC contract | `PtyEntry` fans out to a `Set<Subscriber>` with seq'd ring buffer + reconnect cursor + read-only flag; `PtyApi`/preload/`shared/types` extended. | attach/detach/remount/second-subscriber tests; existing terminal still attaches. |
| 3 | Lifecycle events + id registry + token (A.0.3/A.4) | Renderer→main pushes for window/session/pane create·ready·split·move·close·kind-change + pty spawn/exit + stale-id invalidation; main mints `externalId ⇄ {windowId,sessionId,paneId}` + per-pane `paneToken`. | id-registry unit tests (bijection, invalidation); `PINE_*` present in a spawned pane's env. |
| 4 | Control socket + capability broker (A.1/§6.1) | `controlServer.ts` (Unix socket + JSON-RPC), mandatory `hello` token proof, capability grant store, audit log. | protocol tests: unauth'd conn limited to `hello`; valid token → scoped caps; `needs-elevation` path; denial audited. |
| 5 | `pine` CLI (A.2) | `src/cli/index.ts` + `"bin"`; reads `PINE_SOCKET`/`PINE_TOKEN`, forwards `pine <cmd> [args] [--json]`, `pine commands --json`; exit status from `CommandResult`. | CLI↔socket integration test against a stub server. |
| 6 | Command bridge + explicit targeting + verb set (A.3/A.6/F1) | `command:exec` + `command:list` main↔renderer bridge with full `{windowId,sessionId,paneId}` target; `CommandContext.target`; verbs `command.list`,`pane.list`,`pane.focus`,`pane.split`,`terminal.run` (behind `shell`); cross-pane gated. | bridge tests: explicit-target focus activates target session; capability gate on `terminal.run`. |
| 7 | Terminal-state mirror (A.5) + `pane.info` | renderer→main snapshot push with pane generation + replay/live phase + replace semantics; `pane.info`/`blocks.get`/`cwd.get` exposed **only now**. | mirror tests: replay snapshot doesn't register as live commands; `pane.info` reflects latest generation. |

**Sequencing guards (from Codex R2):** `pane.info`/`blocks.get`/`cwd.get` are **not** exposed on the socket until Slice 7 (their data path). The command bridge (Slice 6) depends on the id registry (Slice 3). The socket (Slice 4) depends on the contract (Slice 1). PTY IPC-contract changes (Slice 2) are part of Slice 2, not deferred.

---

## Slice 1 — Command contract upgrade

**Why first:** `pine commands --json`, capability checks, arg validation, and MCP tool-gen all read this contract. Nothing downstream is sound until commands are self-describing. This slice is pure renderer/shared TypeScript — fully unit-testable in the `node` env with zero DOM.

### File Structure (Slice 1)
- **Create** `src/shared/capabilities.ts` — the `Capability` union + `DEFAULT_CAPABILITIES`. In `shared/` because both the renderer (command defs) and main (Slice 4 broker) import it.
- **Modify** `src/renderer/commands/registry.ts` — extend `CommandContext`, `CommandDef`; add `CommandResult`, `TargetMode`, `JSONSchema`, `CommandDescriptor`; change `exec`; add `describe()`.
- **Modify** `src/renderer/commands/builtins.ts` — backfill `capabilities`/`target` on existing commands.
- **Create** `src/renderer/commands/registry.test.ts` — contract tests.

### Task 1: Capability type + contract types on the registry

**Files:**
- Create: `src/shared/capabilities.ts`
- Modify: `src/renderer/commands/registry.ts:10-29` (types) 
- Test: `src/renderer/commands/registry.test.ts`

**Interfaces:**
- Produces: `Capability` (union), `DEFAULT_CAPABILITIES: Capability[]`; `JSONSchema = Record<string, unknown>`; `TargetMode = 'active'|'explicit'|'none'`; `CommandResult<R> = {ok:boolean; result?:R; error?:{code:string;message:string}}`; extended `CommandContext` (adds optional `target`); extended `CommandDef<Args,R>` (adds `argsSchema?`, `resultSchema?`, `capabilities?`, `target?`, `run` returns `R|Promise<R>`).

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/commands/registry.test.ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_CAPABILITIES } from '../../shared/capabilities'
import { CommandRegistry } from './registry'

describe('command contract', () => {
  it('a registered command exposes its declared metadata with defaults', () => {
    const reg = new CommandRegistry()
    reg.register({
      id: 'demo.noop',
      title: 'Demo',
      run: () => 42,
    })
    reg.register({
      id: 'demo.risky',
      title: 'Risky',
      capabilities: ['shell'],
      target: 'explicit',
      argsSchema: { type: 'object', properties: { text: { type: 'string' } } },
      run: () => undefined,
    })
    const noop = reg.describe().find((c) => c.id === 'demo.noop')!
    const risky = reg.describe().find((c) => c.id === 'demo.risky')!
    expect(noop.capabilities).toEqual(DEFAULT_CAPABILITIES)
    expect(noop.target).toBe('active')
    expect(noop.argsSchema).toBeNull()
    expect(risky.capabilities).toEqual(['shell'])
    expect(risky.target).toBe('explicit')
    expect(risky.argsSchema).toEqual({ type: 'object', properties: { text: { type: 'string' } } })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/commands/registry.test.ts`
Expected: FAIL — `describe` is not a method on `CommandRegistry`, and `../../shared/capabilities` cannot be resolved.

- [ ] **Step 3: Create the capabilities module**

```ts
// src/shared/capabilities.ts
/**
 * Capabilities gate every privileged control-plane action (spec §6, §6.1).
 * Posture: pane-scoped trust — a process in a pane holds the DEFAULTs for
 * that pane; elevated caps are granted per-pane by explicit user action.
 */
export type Capability =
  | 'drive-self' // act on the caller's own pane (default)
  | 'read-board' // read the kanban/status board (default)
  | 'send-other-pane' // inject input into a different pane (elevated)
  | 'kill-pane' // close/kill a pane (elevated)
  | 'workspace-wide' // act across the whole workspace (elevated)
  | 'shell' // run a command in a terminal (elevated)
  | 'destructive' // irreversible ops — gated regardless of caller
  | 'phone' // remote gateway access (elevated)

/** Granted to every pane by default under the pane-scoped-trust posture. */
export const DEFAULT_CAPABILITIES: Capability[] = ['drive-self', 'read-board']
```

- [ ] **Step 4: Extend the registry contract types**

Replace `src/renderer/commands/registry.ts:10-29` (the `CommandContext` + `CommandDef` + `AnyCommand` block) with:

```ts
import type { Capability } from '../../shared/capabilities'
import { DEFAULT_CAPABILITIES } from '../../shared/capabilities'

/** Minimal JSON-Schema stand-in (no validator dep yet; shape is opaque here). */
export type JSONSchema = Record<string, unknown>

/** How a command resolves the pane it acts on. */
export type TargetMode = 'active' | 'explicit' | 'none'

/** Uniform result of executing a command (what the socket/CLI return). */
export interface CommandResult<R = unknown> {
  ok: boolean
  result?: R
  error?: { code: string; message: string }
}

/** Context passed to every command (what is "current"). Grows over time. */
export interface CommandContext {
  /** The active session (sidebar entry) the panes belong to. */
  activeSessionId: string | null
  /** The focused pane within the active session's layout. */
  activePaneId: string | null
  /**
   * Explicit target for non-UI callers (CLI / bridge). When present, a
   * command with target:'explicit' acts on this instead of the active session.
   * Wired by the command bridge in Slice 6.
   */
  target?: { windowId?: string; sessionId: string; paneId: string | null } | null
}

export interface CommandDef<Args = void, R = void> {
  id: string
  title: string
  /** Category for grouping in the palette. */
  category?: string
  /** Hide from the palette (e.g. commands that require explicit args from a caller). */
  hidden?: boolean
  /** JSON Schema for args — powers `pine commands --json` + validation. */
  argsSchema?: JSONSchema
  /** JSON Schema for the result. */
  resultSchema?: JSONSchema
  /** Capabilities a caller must hold. Defaults to DEFAULT_CAPABILITIES. */
  capabilities?: Capability[]
  /** How the command resolves its target pane. Defaults to 'active'. */
  target?: TargetMode
  run: (args: Args, ctx: CommandContext) => R | Promise<R>
}

// biome-ignore lint/suspicious/noExplicitAny: registry stores heterogeneous command arg/result types.
type AnyCommand = CommandDef<any, any>

/** Serialized, stable view of a command for external discovery. */
export interface CommandDescriptor {
  id: string
  title: string
  category?: string
  hidden: boolean
  argsSchema: JSONSchema | null
  resultSchema: JSONSchema | null
  capabilities: Capability[]
  target: TargetMode
}
```

- [ ] **Step 5: Add `describe()` to the registry class**

Add this method to `CommandRegistry` (after `list()`, `registry.ts:56`):

```ts
  /** Stable, sorted, defaults-applied serialization — the `pine commands --json` contract. */
  describe(): CommandDescriptor[] {
    return this.list()
      .map((c) => ({
        id: c.id,
        title: c.title,
        category: c.category,
        hidden: Boolean(c.hidden),
        argsSchema: c.argsSchema ?? null,
        resultSchema: c.resultSchema ?? null,
        capabilities: c.capabilities ?? DEFAULT_CAPABILITIES,
        target: c.target ?? 'active',
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/renderer/commands/registry.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

```bash
git add src/shared/capabilities.ts src/renderer/commands/registry.ts src/renderer/commands/registry.test.ts
git commit -m "feat(commands): add capability/arg/result/target contract + describe()

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2: `exec` returns a `CommandResult` (no longer throws)

**Files:**
- Modify: `src/renderer/commands/registry.ts:58-63` (the `exec` method)
- Test: `src/renderer/commands/registry.test.ts`

**Interfaces:**
- Produces: `CommandRegistry.exec<Args,R>(id, args?): Promise<CommandResult<R>>` — resolves `{ok:false, error:{code:'unknown-command'}}` for unknown ids, `{ok:false, error:{code:'command-failed'}}` on a thrown command, `{ok:true, result}` otherwise.
- Consumes: `CommandResult` (Task 1).

- [ ] **Step 1: Write the failing test** (append to `registry.test.ts`)

```ts
describe('exec returns CommandResult', () => {
  it('wraps success, unknown, and thrown into a uniform result', async () => {
    const reg = new CommandRegistry()
    reg.register<{ n: number }, number>({ id: 'math.double', title: 'Double', run: ({ n }) => n * 2 })
    reg.register({ id: 'boom', title: 'Boom', run: () => { throw new Error('kaboom') } })

    expect(await reg.exec('math.double', { n: 21 })).toEqual({ ok: true, result: 42 })

    const unknown = await reg.exec('nope')
    expect(unknown.ok).toBe(false)
    expect(unknown.error?.code).toBe('unknown-command')

    const thrown = await reg.exec('boom')
    expect(thrown.ok).toBe(false)
    expect(thrown.error?.code).toBe('command-failed')
    expect(thrown.error?.message).toContain('kaboom')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/commands/registry.test.ts`
Expected: FAIL — current `exec` returns `Promise<void>` and throws on unknown.

- [ ] **Step 3: Replace `exec`**

Replace `registry.ts:58-63` with:

```ts
  /**
   * Execute a command by id. Never throws — returns a uniform CommandResult so
   * the socket/CLI can map it to an exit status. UI callers may ignore the result.
   */
  async exec<Args, R = unknown>(id: string, args?: Args): Promise<CommandResult<R>> {
    const cmd = this.commands.get(id)
    if (!cmd) {
      return { ok: false, error: { code: 'unknown-command', message: `unknown command: ${id}` } }
    }
    try {
      const result = (await cmd.run(args, this.contextProvider())) as R
      return { ok: true, result }
    } catch (e) {
      return { ok: false, error: { code: 'command-failed', message: e instanceof Error ? e.message : String(e) } }
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/commands/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck (catches callers that relied on the old signature)**

Run: `npm run typecheck`
Expected: no errors. Existing internal delegators (`pane.splitRight`/`pane.splitDown` at `builtins.ts:42,49`) return `commands.exec(...)` — now typed `Promise<CommandResult>`; that is a valid `R`, so they still typecheck. UI callers (`App.tsx`, `Pane.tsx`) ignore the return — unaffected. If typecheck flags a caller that destructured a `void`, fix it to ignore the result.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/commands/registry.ts src/renderer/commands/registry.test.ts
git commit -m "feat(commands): exec returns CommandResult instead of throwing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3: Backfill capability + target metadata on built-in commands

**Files:**
- Modify: `src/renderer/commands/builtins.ts` (add `capabilities`/`target` to registrations)
- Test: `src/renderer/commands/registry.test.ts` (via a small builtins assertion)

**Interfaces:**
- Consumes: `Capability`, `TargetMode`, `commands.describe()`.
- Produces: existing command ids now carry explicit `target`/`capabilities` (defaults where unspecified).

Metadata to apply (pane-scoped-trust defaults; nothing here is elevated yet — `terminal.run`/cross-pane land in Slice 6):

| command | target | capabilities |
|---|---|---|
| `pane.split`, `pane.splitRight`, `pane.splitDown`, `pane.close`, `pane.focus`, `pane.move`, `pane.remove` | `active` | *(default)* |
| `session.new` | `none` | *(default)* |
| `palette.toggle`, `view.toggleRail`, `app.openSettings` | `none` | *(default)* |

- [ ] **Step 1: Write the failing test** (append to `registry.test.ts`)

```ts
import { registerBuiltinCommands } from './builtins'
import { commands } from './registry'

describe('builtins declare targets', () => {
  it('session.new is target:none, pane.split is target:active', () => {
    registerBuiltinCommands()
    const byId = Object.fromEntries(commands.describe().map((c) => [c.id, c]))
    expect(byId['session.new'].target).toBe('none')
    expect(byId['pane.split'].target).toBe('active')
  })
})
```

Note: `registerBuiltinCommands()` mutates the module-singleton `commands` and throws on double-register — keep this in its own test file run, or guard with `commands.has('session.new')`. If flakiness appears from the singleton, split this assertion into `builtins.test.ts` that imports fresh. (Vitest isolates modules per test file by default, so a dedicated file is clean.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/commands/registry.test.ts`
Expected: FAIL — `session.new` currently has no `target`, so `describe()` defaults it to `'active'`, not `'none'`.

- [ ] **Step 3: Add `target: 'none'` to the app/session/view commands**

In `builtins.ts`, add `target: 'none',` to the registration objects for `session.new` (`:101-109`), `palette.toggle` (`:111-116`), `view.toggleRail` (`:118-123`), `app.openSettings` (`:125-130`). Example for `session.new`:

```ts
  commands.register({
    id: 'session.new',
    title: 'New Session',
    category: 'Session',
    target: 'none',
    run: () => {
      useUIStore.getState().leaveSettings()
      useSessionsStore.getState().addSession()
    },
  })
```

Pane commands already act on the active pane — their default `target:'active'` is correct, so leave them unless a later slice needs `'explicit'`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/commands/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`

```bash
git add src/renderer/commands/builtins.ts src/renderer/commands/registry.test.ts
git commit -m "feat(commands): declare target mode on built-in commands

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 4: Verify the app still builds and behaves

**Files:** none (verification task)

- [ ] **Step 1: Full typecheck + lint + tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass (the pre-existing `tree.test.ts` plus the new `registry.test.ts`).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: electron-vite build succeeds — the contract change is source-compatible.

- [ ] **Step 3: Smoke the running app** (if a display is available)

Run: `npm run dev`, split a pane and open Settings from the palette.
Expected: unchanged behavior — the contract upgrade is invisible to the UI. (If headless, rely on Steps 1–2; note in the commit that manual smoke was deferred.)

- [ ] **Step 4: Commit any lint/format fixups** (if `npm run format` changed files)

```bash
git add -A && git commit -m "chore(commands): format + lint after contract upgrade

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

**Slice 1 exit criterion:** `npm run typecheck && npm run lint && npm test && npm run build` all green; `commands.describe()` returns sorted descriptors with defaults applied; `exec` yields `CommandResult`. The registry is now self-describing — the substrate Slices 4–6 consume.

---

## Slices 2–7 — expansion note

Each remaining slice is expanded to the same TDD depth (failing test → minimal impl → green → commit) **at execution time, after reading its target files** (`src/main/index.ts` pty section, `src/shared/types.ts`, `src/preload/index.ts`, `src/main/lsp.ts`, `Terminal.tsx`, `sessionsStore.ts`, `layoutStore.ts`). This keeps every code block matched to the real current source rather than guessed. Their scope, order, dependencies, and exit tests are fixed by the roadmap table and the sequencing guards above; only the step-level code is deferred. Recommended cadence: finish and review Slice N, then expand Slice N+1.

## Self-Review (Slice 1)

- **Spec coverage:** Slice 1 implements spec A.0.1 (contract upgrade) and the parts of Codex F5 that are design-level (arg/result/capability schema on the registry); the `command:list` *bridge* half of F5 is correctly deferred to Slice 6 where the main↔renderer channel exists. Capability *enum* source-of-truth (Codex "new blocker #1") is seeded here (`capabilities.ts`) and consumed by the Slice 4 broker.
- **Placeholder scan:** no TBD/TODO; every code step shows complete code.
- **Type consistency:** `Capability`, `CommandResult`, `TargetMode`, `CommandDescriptor`, `describe()` names are used identically across Tasks 1–3 and referenced consistently in the roadmap for Slices 4/6.
- **Gap check:** `terminal.run`, cross-pane `send`, and `pane.info` are intentionally absent from Slice 1 (Slices 6/7) — matches the sequencing guards.
