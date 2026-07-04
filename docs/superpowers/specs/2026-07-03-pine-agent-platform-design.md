# Pine Agent Platform — Control Plane, Cross-Agent Bus + Kanban, and Phone Connect

**Status:** Draft for review (pre-Codex-hardening)
**Date:** 2026-07-03
**Author:** brainstormed with Claude, grounded on three research probes + `docs/ARCHITECTURE.md` recon
**Supersedes/extends:** `docs/ARCHITECTURE.md` §5.11 (control layer), §5.6 (agent status board + cross-agent send), §5.13 (companion phone app) — this spec takes those planned milestones to build-ready depth.

---

## 0. Assumed decisions (confirm on review)

These four were my recommendations; the user was away when I wrote this, so I proceeded on them. **Each is a flip-point — changing one reshapes the affected phase, not the whole spec.**

| # | Decision | Assumed | Alternatives if flipped |
|---|----------|---------|--------------------------|
| D1 | Build focus / spec depth | **Spine first.** Phase A to build-ready depth; B + C as grounded outline. | Full end-to-end spec; or Bus+Kanban-first; or Phone-first. |
| D2 | Primary cross-agent mode | **Baton handoff with context**, with live-inject shipped first as the cheap increment; board-mediated emerges from the Kanban. | Messaging-first, or board-only. |
| D3 | Kanban richness + storage | **Full board (columns/cards/WIP/assignee), per-repo git-friendly file** (`.pine/board.json`). | Global app SQLite; or lightweight read-mostly status board. |
| D4 | Phone reach | **DECIDED (user): LAN server + QR pair-from-menu; WAN = bring-your-own Tailscale. NO hosted relay, NO login/accounts** (cmux-style). | (Relay/account model explicitly rejected.) |

### 0.1 Codex review round 1 — incorporated (verdict: no-go as written → revised)

An adversarial architecture review (Codex, 2026-07-03) returned 9 findings; all are folded into this v2. Resolutions:

| # | Sev | Finding | Resolution in v2 |
|---|-----|---------|------------------|
| F1 | High | `paneId` alone can't target commands — built-ins need the active session (`builtins.ts:17,64,70`). | §2.3 claim corrected; **explicit target model** `{windowId, sessionId, paneId, externalId}` threaded through the bridge (A.3). |
| F2 | **Critical** | `0600` socket separates Unix users, not trusted panes from same-user processes; "capability broker" under-specified. | §6 + A.7 rewritten: **per-pane bearer token** (`PINE_TOKEN`), proof-of-possession handshake, no privileged auto-discovery, method allowlists, schema validation, audit log in v1. |
| F3 | High | Handoff = properties, not a recoverable state machine; board file & SQLite diverge. | **Single source of truth = SQLite**; `.pine/board.json` demoted to a *generated committed projection* (B.1). Formal state machine + transactional claim/ack + fencing tokens + per-recipient seq (B.2). **Refines D3.** |
| F4 | High | Phone pty streaming incompatible with single-`wc` `PtyEntry` (`index.ts:40,277,286`). | New prerequisite **A.0.2 PTY multi-subscriber refactor** (fanout, refcount, seq'd ring, reconnect cursor, read-only mode). |
| F5 | High | `pine commands --json` not build-ready — `CommandDef` has no arg/result/capability schema (`registry.ts:18,59`). | New prerequisite **A.0.1 command-contract upgrade** before the socket. |
| F6 | Med | Terminal-state deltas duplicate/mislead vs replay re-parsing (`Terminal.tsx:87,139`, `blocksStore.ts:82`). | A.5 changed to **snapshot mirror** w/ pane generation + replay-vs-live markers + replace semantics. |
| F7 | Med | External ids under-specified; no pane lifecycle sync. | New prerequisite **A.0.3 pane-lifecycle events** (create/split/move/close) as precondition for id registry + targeting. |
| F8 | Med | LAN gateway security too optimistic. | C.1/C.3: gateway **opt-in, off by default**, explicit interface bind, short-lived pairing + device keys, per-method scopes, **read-only terminal default**. |
| F9 | Low | Over-scoped for "spine first". | §9 **hard MVP cut**: contract + PTY refactor + authenticated socket + target model + `pane.list`/`pty.write`/`command.list` + 1–2 safe commands. Kanban/MCP/phone/leases deferred until the spine is proven. |

**Two resolutions touch your assumed decisions and need your eyes (see §0):** F3 refines **D3** (the per-repo board file becomes a generated projection, not the live authority — it still travels with the repo and diffs cleanly), and F9 tightens **D1** (Phase A's MVP is narrower than first drafted; Kanban/phone move firmly behind the proven spine).

### 0.2 Codex review round 2 — verification pass (verdict: still no-go, but converged)

Round 2 verified the revision rather than re-litigating. Outcome: the **architecture is sound**; what remains is (i) one genuine **product/security decision** for the user, and (ii) **implementation-level concreteness** that is the natural output of the writing-plans phase (Codex's own words: "split A-MVP into implementation-ready slices"). Status per finding:

- **Fully verified:** F4 (PTY multi-subscriber). **Verified, contingent on the security decision:** F8 (gateway).
- **The one real decision — F2 / capability grants (blocker):** an env-injected `PINE_TOKEN` cannot defend a pane against *its own child processes* (they inherit the env), so it does not meet the stated "compromised npm postinstall / agent subprocess" threat model. **This is a threat-model choice, not a bug to patch** — see §6.1 (added). The capability *grant store* (where grants live, defaults, revocation) is also undefined and depends on this choice.
- **Implementation-concreteness items (resolve per-slice in writing-plans, not more spec ping-pong):**
  - F1 — MVP semantics of `pane.focus` on a non-active session/window (does external focus steal focus?).
  - F5 — a `command:list` bridge (main↔renderer) + per-window aggregation is needed alongside `command:exec`.
  - F3 — persisted task enum (`submitted|working|…`) must include/derive `claimed`/`reclaimed` to match the B.2 state machine.
  - F6 — exact replay-begin/replay-end + parser-drain timing before main answers `pane.info`.
  - F7 — lifecycle events must also cover window create/ready/close, detached-window readiness, pane-transfer-between-windows, pty spawn/exit, stale-id invalidation (current tear-off tracks only `{id,title}`, `index.ts:164-166`).
  - New — the PTY refactor must extend the **shared/preload IPC contract** (`shared/types.ts:68-80`, `preload/index.ts:36-52`), not just `main/index.ts`: attach-mode, replay cursor, seq'd data event, read-only flag.
  - New — don't expose `pane.info`/`blocks.get`/`cwd.get` on the socket until A.5 lands (sequencing).
  - New — board projection needs repo-identity namespacing + file-edit reconciliation rules.

**Decision gate:** §6.1 (security posture) is the user's call; once set, A-MVP splits cleanly into implementation-ready slices. The concreteness items above are tracked as the writing-plans backlog.

### 0.3 Security posture — DECIDED 2026-07-03: pane-scoped trust

**Decision:** Phase-A's threat model is **"a process inside a pane is trusted at that pane's scope."** (Confirmed by user; §6.1 is now settled, not pending.) Rationale: a pane's shell can already run anything as the user (`rm -rf ~` needs no `pine`), so defending a pane from its own children buys little for a local dev tool. The token's real job is **identity + confinement**: a process in pane X can act *only* as pane X, and the genuinely dangerous new powers — inject into another pane, kill panes, drive the whole workspace, phone access — require **explicit, separately-granted capabilities + user-mediated elevation**, never mere token possession. Alternative (rejected unless the user wants it): per-pane process sandboxing to defend a pane from its own subprocesses — large effort, dubious payoff here.

---

## 1. Overview

Turn Pine from a terminal workspace into an **agent-orchestration workspace**: agents (and the user) can drive Pine programmatically, agents can hand work to each other with full context, a shared Kanban is the coordination substrate for both humans and agents, and all of it is reachable from a phone.

The user framed this as four features. Research + code recon collapse them into **one spine and three layers**:

```
                        ┌──────────────────────────────────────────┐
   Phone (LAN/relay) ──►│  C. Control Gateway (network transport)   │
                        └───────────────────┬──────────────────────┘
   Claude Code / Codex ─(MCP)─┐             │
   `pine` CLI ───────────────┐│  ┌──────────▼───────────┐
                             ▼▼  │  B. Bus + Kanban       │  (one datastore,
   ┌─────────────────────────────┤     two surfaces)      │   two views)
   │  A. CONTROL PLANE (spine)   │  └──────────┬───────────┘
   │  control socket · pine CLI  │             │
   │  command bridge · env inject│◄────────────┘
   │  stable ids · single-inst.  │
   └──────────────┬──────────────┘
                  │ existing IPC / command registry / pty manager
        ┌─────────▼──────────────────────────────────┐
        │  Existing Pine (main + renderer, unchanged) │
        └─────────────────────────────────────────────┘
```

- **Pillar 1 (CLI control) = the spine itself.**
- **Pillars 2 + 3 merge**: cross-agent handoff and the Kanban are *the same task rows* seen two ways ("every handoff is a row any profile or human can see and edit").
- **Pillar 4 = the spine over a network transport** — "the phone is just another client of the command registry."

### Non-goals (this spec)
- Not building an agent runtime — Pine orchestrates agent CLIs (Claude Code et al.), consistent with `ARCHITECTURE.md` §8.
- No hosted cloud/accounts in the first cut (D4). Relay is a later sub-phase.
- No cross-org/untrusted-agent federation (A2A's reason to exist) — all panes are same-machine, trusted. We borrow A2A's *schema*, not its transport.

---

## 2. Grounding

### 2.1 Alignment with existing design intent
`docs/ARCHITECTURE.md` already specifies this feature set as unbuilt milestones:
- **M3 · Phase 10** — control socket + `pine` CLI, `PINE_SOCKET`/`PINE_PANE_ID`/`PINE_WORKSPACE` env, `pine commands --json`, per-session scoped socket (§5.11, §7).
- **M3 · Phase 14** — status board + cross-agent send, cmux `send`/`set-progress` style (§5.6).
- **M4 · Phase 16** — control gateway (WebSocket/JSON-RPC), QR pairing, LAN-first + optional relay, capability subset (§5.13).
This spec is those phases, pulled forward and detailed.

### 2.2 Research basis (patterns, not vendor claims)
Two of the named references ("OpenClaw", "NousResearch hermes-agent") postdate the author's training and could not be independently verified; their reported scale is treated as unconfirmed. The design therefore rests only on **independently-standard primitives**, each of which the probes corroborated across multiple sources:
- **Local hub owned by one always-on process**, loopback-only, JSON frames validated against a schema. (Pine's `main` is that process — it already parents every pty.)
- **Durable mailbox + append-only event log + idempotency dedupe + per-recipient FIFO lane** for at-least-once, ordered, replayable delivery.
- **Lease/claim baton handoff** with typed context payload; reclaim on lease timeout.
- **Blackboard = the Kanban**: handoffs are inspectable, human-editable rows.
- **MCP as the agent-facing surface**: agent CLIs already speak MCP, so exposing the bus as an MCP server = near-zero integration cost. Borrow **A2A's `Task`/`TaskState`/`Part`/`Artifact` schema**; keep **Swarm's one rule** — *a handoff must carry all context the next agent needs*.

### 2.3 Code seams (from recon, with anchors)
- **Control server lives in `main`** — renderer is `sandbox:true`+`contextIsolation:true` (`src/main/index.ts:97-105`) and cannot host a socket. Register alongside `registerPtyIpc`/`registerLspIpc` in `app.whenReady()` (`src/main/index.ts:336-341`); tear down in `before-quit` (`src/main/index.ts:348-358`).
- **Framing is already solved** — `vscode-jsonrpc` `StreamMessageReader`/`Writer` are a dependency and used in `src/main/lsp.ts:5-6,94-95`. Reuse for the socket protocol. `lsp.ts`'s keyed-child-process manager is the template for a `controlServer.ts` module.
- **Cross-agent inject is nearly free** — injecting into a pane's stdin is the body of `pty:write` (`src/main/index.ts:295`): `ptys.get(targetPaneId)?.pty.write(text)`.
- **Env injection point** — `pty:attach` builds spawn env at `src/main/index.ts:254-260`, already merging `shellIntegrationSpawnOptions` env (`src/main/shellIntegration.ts:207-231`). Inject `PINE_*` there.
- **Command registry is the action spine** — `src/renderer/commands/registry.ts` (`exec` at 58-63) + `builtins.ts`; but it only runs in-renderer today. Driving it from main needs a new round-trip channel (Seam B below).
- **Panes are *rendered* once across all sessions** by `SurfacePool` (`src/renderer/components/SurfacePool.tsx:18-32`), so a pane's *surface* is reachable regardless of the active session tab. **But command execution is not paneId-only:** `builtins.ts` resolves through the active session — `pane.focus` needs `ctx.activeSessionId` (`builtins.ts:64,70`) and the context provider reads the *current* active session (`builtins.ts:17`). **Correction (Codex F1): external targeting must carry `{windowId, sessionId, paneId}`, not `paneId` alone.** See A.3.
- **Terminal state is renderer-only** — `blocksStore` + OSC-7 cwd live in renderer zustand (`src/renderer/components/Terminal.tsx:90-107`, `src/renderer/stores/blocksStore.ts`). Main can't answer "what is pane X running" without a mirror channel.
- **Persistence precedent** — only `settings.json` is persisted (`src/main/index.ts:180`, `settingsStore.ts`). App data path via `app.getPath('userData')`.
- **Gaps to build from scratch:** no `pine` CLI / `bin` field (`package.json:1-9`), no single-instance lock, no protocol registration, no server of any kind.

### 2.4 Constraints / gotchas to design around
- **Renderer can't own a socket** → server in `main` (or later a `utilityProcess`).
- **`sessionsStore` ↔ `layoutStore` require-cycle is real** (`sessionsStore.ts:2` ↔ `layoutStore.ts:15`), surviving only because cross-store access is deferred into action closures. **Any new store touching both (a Kanban store) must not deepen it** — use a one-way import or a shared accessor module.
- **Ids are ephemeral counters** (`layout/tree.ts:11,18-21`, `sessionsStore.ts:35-39`), reset each launch, non-persisted. The control plane must mint and track **its own durable external ids** — never expose the renderer's internal ids as an API.
- **`node-pty` is optional/lazy** (`src/main/index.ts:23-34`); every pty-touching feature degrades gracefully.
- **`pty` is keyed by pane id only** — `main` has no notion of "session"; session-scoped verbs resolve renderer-side via the command bridge.

---

## 3. Phase A — Control Plane (build-ready)

The foundation. Deliverable: an agent in a pane runs `pine split`, `pine focus <id>`, `pine open foo.ts`, `pine run "npm test"`, `pine list`, `pine commands --json` and it drives the live UI, targeting its own pane by default.

### A.0 Prerequisites (must land before the socket — Codex F4/F5/F7)
The socket server is worthless until the substrate it drives is ready. Three refactors come **first**, each independently testable and shippable:

- **A.0.1 — Command contract upgrade (F5).** Extend `CommandDef` (`src/renderer/commands/registry.ts:18`) from `{id,title,category,hidden,run}` to add `argsSchema` (JSON Schema), `resultSchema`, `capabilities: Capability[]`, and `target: 'active' | 'explicit' | 'none'`. Change `exec` (`registry.ts:59`) from `Promise<void>` to `Promise<{ok, result?, error?}>`. Provide stable serialization for `command.list`. **This is the contract `pine commands --json`, the MCP tool-gen, and capability checks all depend on** — nothing else in Phase A is sound without it.
- **A.0.2 — PTY multi-subscriber refactor (F4).** Today `PtyEntry` holds a single `wc` (`src/main/index.ts:40`) and pushes only to it (`:277`), with a 3s detach-kill (`:286`) and a raw capped string buffer (`:46,:264`). Refactor to: a **`Set<Subscriber>`** (each with an input-permission flag + a read cursor), **refcounted lifecycle** (pty dies when the last *owning* subscriber leaves, not the first detach), a **sequence-numbered ring buffer** (each chunk gets a monotonic seq), and **reconnect-by-cursor** replay. Existing single-renderer attach becomes "one subscriber." This unblocks both the terminal-state mirror (A.5) and phone streaming (C.2) and removes the current fragile detach-grace race. **Biggest single piece of Phase A.**
- **A.0.3 — Pane/session lifecycle events (F7).** Add explicit renderer→main pushes on pane create/split/move/close and session add/close/switch (today main only learns of a pane at `pty:attach`, `:230`). These feed the id registry (A.4) and are the precondition for any external targeting. Symmetric to the existing `window:maximized` push (`:111-113`).

### A.1 Control server (`src/main/controlServer.ts`, new)
- **Transport:** `net.createServer()` on a **Unix domain socket** at `${XDG_RUNTIME_DIR}/pine-${instanceId}.sock` (Windows: named pipe `\\.\pipe\pine-${instanceId}`; branch by platform). Per-`ARCHITECTURE.md` §4.1/§7 default. Loopback-equivalent (filesystem-permission scoped, `0600`). No TCP in Phase A.
- **Protocol:** JSON-RPC 2.0 framed with `vscode-jsonrpc` `StreamMessageReader`/`Writer` over the socket stream (same as `lsp.ts`). Methods: `hello` (**mandatory first frame** — carries `{paneToken, paneId}`; see §6), then `command.exec`, `command.list`, `pane.info`, `blocks.get`, `cwd.get`, `bus.*` (Phase B). **Any method before a verified `hello` is rejected and the connection closed.**
- **Auth (F2):** the socket accepting a connection grants *nothing*. The connection's capability set is derived only from a valid `paneToken` proven in `hello` (per-pane, unguessable, injected as `PINE_TOKEN` at spawn — A.4). Unauthenticated connections get a null capability set (can call only `hello`). No "trusted because it reached the socket."
- **Lifecycle:** `registerControlServer(getMainWindow)` called in `app.whenReady()` next to the other `registerX` calls (`src/main/index.ts:336-341`); `stopControlServer()` (unlink socket, close connections) in `before-quit` (`:348-358`).
- **Connection model:** clone `lsp.ts`'s `Map<connId, Conn>` with per-connection cleanup on socket close. Each connection carries the **capability set** resolved from its verified `paneToken`; every method call is re-checked against it and its args validated against the command's `argsSchema` (A.0.1) before dispatch; denials and privileged calls are appended to an audit log.

### A.2 `pine` CLI (`src/cli/`, new build target)
- New standalone Node entry `src/cli/index.ts`, built separately (esbuild/tsx step; **not** part of `electron.vite.config.ts` which only builds main/preload/renderer). Add `"bin": {"pine": "./out/cli/index.js"}` to `package.json`.
- Reads `PINE_SOCKET` from env (falls back to discovering the running instance's socket by convention); connects, performs `hello` with `PINE_PANE_ID`/`PINE_WORKSPACE`, forwards `pine <command> [args...] [--json]` as a `command.exec`, prints the reply, exits with the command's status.
- `pine commands --json` → `command.list` → emits every command id + JSON-schema'd arg spec (the agent-discovery contract, `ARCHITECTURE.md` §5.11). Doubles as the MCP tool-generation source in Phase B.
- Degrades with a clear message if no instance is running / socket absent.

### A.3 Command bridge (Seam B — main ⇄ renderer round-trip)
The control server (main) must invoke `commands.exec()` (renderer), **with an explicit target — not a bare paneId (Codex F1).**
- **Target resolution:** the socket call carries an `externalId` (or "self" = the caller's `PINE_PANE_ID`). Main's id registry (A.4) resolves it to a full **`{windowId, sessionId, paneId}`** triple; a stale/unknown id is a typed error, not a silent no-op.
- `ipcMain.handle('command:exec', (e, {target, id, args}) => …)` sends `command:invoke` (with the full `target`) to **the window that owns `target.windowId`** and awaits a correlated reply, mirroring `window:tear-off`'s reply pattern (`src/main/index.ts:206-216`).
- Main holds a **per-window registry** (`windowId → BrowserWindow`), not just the single `detachedPanes` map (`:82`); the primary window is registered in `createWindow()` (`:121-145`).
- **Renderer adapter** subscribes to `command:invoke` and builds a `CommandContext` **from the passed `{sessionId, paneId}`** — the key change is that `CommandContext` (and the built-ins reading it, `builtins.ts:17,64,70`) must accept an *explicit* target instead of always reading the active session. Built-ins that mutate a non-active session must be verified to work off-active (some, e.g. `pane.focus`, will also *switch* the active session as a side effect — decide per-command whether external calls should steal focus).
- Return `commands.exec()`'s new `{ok,result,error}` (A.0.1) back over the socket as the CLI's result + exit status.

### A.4 Env injection + stable id registry (Seam C)
- **Id registry (main):** a bijection `externalId (ULID) ⇄ {paneId, sessionId, windowId}` plus a per-pane **`paneToken`** (crypto-random, unguessable). Populated by the **A.0.3 lifecycle events** (create/split/move/close) — *not* by `pty:attach` alone, since a pane can exist before it has a pty. External ids are the only ids the CLI/bus/gateway expose; the renderer's internal counters (`tree.ts:11`, `sessionsStore.ts:35`) are never surfaced. Stable within an app run; cross-restart durability rides on session-persistence (M3·P12) — flagged, not blocking.
- At `pty:attach` env assembly (`src/main/index.ts:254-260`, beside the existing `ZDOTDIR` injection in `shellIntegration.ts:207-231`), inject `PINE_SOCKET`, `PINE_PANE_ID` (external id), **`PINE_TOKEN` (the pane's `paneToken` — the credential the CLI proves in `hello`)**, `PINE_WORKSPACE`. Because the token is per-pane and only handed to that pane's own shell, a process in pane X cannot forge pane Y's identity.

### A.5 Terminal-state mirror (Seam D)
Chosen approach: **renderer → main push of snapshots, not raw store mutations (Codex F6).** The renderer stays the single parsing authority (it already handles buffer-truncation recovery, `blocksStore.ts:70-100`), but the mirror must not naïvely forward every mutation, because remount resets blocks and **replays buffered output, re-firing OSC handlers as if live** (`Terminal.tsx:87,139`) and block ids embed `Date.now()`+random (`blocksStore.ts:82`) — so a replay would look like brand-new commands to main.
- Each pane carries a **generation counter** bumped on remount/reset. The mirror pushes `{paneId, generation, phase: 'replay'|'live', blocks, cwd}` over a new `terminal:state` channel (symmetric to `window:maximized`, `index.ts:111-113`).
- Main applies **replace semantics** per `(paneId, generation)` — a new generation wholesale replaces that pane's read-model rather than appending — and ignores `phase:'replay'` deltas for "is a command running *now*" queries. Cwd updates are **debounced**.
- Control server then answers `blocks.get`/`cwd.get`/`pane.info` from this read-model.

### A.6 Command surface v1
Extend `builtins.ts` and expose over the socket: `pane.split{dir}`, `pane.focus{id}`, `pane.close{id}`, `pane.zoom{id}`, `pane.list`, `editor.open{path}`, `terminal.run{text,paneId?}`, `terminal.new{cwd?}`, `session.new{kind,workDir}`, `workspace.setDir{path}`, `status.set{paneId,text,state}`. Context-aware default target = caller's `PINE_PANE_ID` (`pine split` splits *its own* pane).

### A.7 Security (Phase-A slice of §6)
Per-connection capability set; the socket is per-instance and `0600`. `terminal.run` and any destructive verb require the `shell`/`destructive` capability; agents get a scoped set. Full permission broker detailed in §6.

### A.8 Testing (Phase A)
- Unit: id-registry bijection; command-arg schema validation; CLI arg→RPC mapping.
- Integration: spin the control server on a temp socket, drive `command.exec` end-to-end against a fake renderer stub asserting `commands.exec` is called with the right context; assert capability denial paths.
- Follows existing `vitest` `node` env (`vitest.config.ts`) — no DOM needed for the main-side server.

---

## 4. Phase B — Bus + Kanban (grounded outline)

One coordination substrate, two surfaces: agents write/claim via CLI+MCP; humans see/drag in a panel. **Single source of truth (Codex F3): SQLite is authoritative for all task + delivery state.** The earlier "two co-equal stores" framing is dropped — it invited divergence on claim/ack/lease.

- **Authority — SQLite (WAL)** at `~/.local/share/pine/bus.db`: task rows *and* their lifecycle state, mailboxes, append-only event log (replay cursor), idempotency dedupe, leases with fencing tokens. One writer (main); all transitions are transactional.
- **Projection — per-repo `.pine/board.json`** (**refines D3**): a **generated, committed snapshot** of the board, written by main whenever task state changes and re-imported to seed a fresh DB. It travels with the repo and diffs cleanly in PRs, but it is **downstream** of SQLite, never a second authority. Human edits to the *file* are treated as an import request, reconciled by main under the same transactional writer — not applied blind. (If you'd rather the file be authoritative, that's the D3 flip: simpler git story, but then the bus loses transactional leases/FIFO — call it on review.)

### B.1 Schema (envelope + payload; borrowed from A2A `TaskState`)
Envelope: `{v, id(ULID), type: message|handoff|ack|status|broadcast, from: "pane:<ext>/<agent>", to, ts, threadId, replyTo?, idempotencyKey, ack: none|required, payload}`.
Task/handoff row (the Kanban card): `{taskId, threadId, title, state: submitted|working|input-required|completed|failed|canceled, owner?, assignee?, priority, lease{ttlSeconds}?, column, workDir, context{summary(required), openFiles[], artifacts[]( {kind,path} ), transcriptRef}, createdAt, updatedAt}`.
Large blobs (diffs/logs/transcripts) are **file artifacts referenced by path** (e.g. `.pine/handoff/<thread>.patch`), never inlined — keeps rows diffable and the bus light.

### B.2 Delivery discipline + handoff state machine (Codex F3)
Not a list of properties — a recoverable machine with defined atomic boundaries:
- **States:** `submitted → claimed → working → (completed | failed | input-required | canceled)`, plus `reclaimed` when a lease expires. Every transition is a **single SQLite transaction** (compare-and-swap on a per-row `revision`); a losing writer retries against the new revision.
- **Claim = exactly-one-owner** via a transactional `submitted→claimed` CAS that also writes a **fencing token** (monotonic). Any later state write must present the current fencing token, so a resurrected zombie owner whose lease already expired is rejected.
- **Lease reclaim:** an owner silent past `lease.ttl` → a sweeper transitions `working→reclaimed→submitted` with a bumped fencing token; the task re-enters the target's FIFO lane.
- **Ordering:** **per-recipient FIFO lane** with per-recipient monotonic sequence numbers; a consumer acks by sequence.
- **Idempotency:** `idempotencyKey` dedupe cache makes redelivery safe; ACK required on handoffs.
- **Crash recovery:** on startup, main scans for `claimed/working` rows with expired leases → reclaim; unacked outbound → replay from the event-log cursor. Back-pressure via per-agent concurrency cap + bounded inbox with an explicit overflow policy.
- **Dropped-context guard (Swarm's rule):** the `pine_handoff` tool schema makes `context.summary` **and** ≥1 artifact **required** — the baton can't pass empty.

### B.3 Surfaces
- **CLI verbs:** `pine send <to> <text>`, `pine handoff <to> --task … --summary … --artifact …`, `pine claim <taskId>`, `pine inbox [--drain]`, `pine wait`, `pine kanban add|move|list|assign|done`.
- **MCP server** (`src/main/bus/mcp.ts`): exposes `pine_send`, `pine_handoff`, `pine_claim`, `pine_wait`, `pine_inbox`, `pine_board` as tools over MCP (stdio for locality, or loopback Streamable HTTP for a shared endpoint; validate `Origin`, bind loopback). Auto-generated from the same schema as `pine commands --json`. Agents get comms as ordinary tool calls.
- **Claude Code skill** (`.claude/skills/pine-bus/…`): a documented recipe wrapping the CLI/MCP tools — how to hand off, claim, report status, read the board.
- **Kanban panel (renderer):** a dockable panel rendering `.pine/board.json` columns/cards; human drag/edit writes back through a new `kanban:*` IPC pair (sourced in main to avoid a redundant renderer round-trip when *external* agents update the board — recon Seam E), with a `kanban:changed` push to re-render (same per-entity push idiom as `pty:data:${paneId}`). New `kanbanStore` must respect the require-cycle constraint (§2.4).

### B.4 Increment order within B
1. **Live inject** (`pine send` → `pty.write`) — nearly free, ships first (D2).
2. **Board file + panel** (human-usable Kanban).
3. **Durable bus** (mailbox/log/idempotency/FIFO/lease) + handoff protocol + MCP surface + skill.

---

## 5. Phase C — Phone Connect (grounded outline)

"The phone is just another client of the command registry." Reuse Phase A's command surface + Phase B's board over a network transport.

### C.1 Control gateway (`src/main/gateway/`, new)
- **Off by default, opt-in (Codex F8).** The gateway ships disabled; enabling it is an explicit user action that binds to a **user-selected interface** (not "whatever the LAN is") and shows an always-visible "remote active" indicator.
- **First cut (D4):** embedded **HTTPS + WebSocket** server, serving a mobile web UI. **mDNS** discovery (opt-in). **Pairing = short-lived code + device key**, not just a URL token: desktop shows a QR encoding a *pairing* secret valid for ~60s; on scan the phone generates a device keypair, registers its public key, and gets a **per-device, revocable** credential. The URL is never the credential (defeats token-in-URL theft). TLS (bundled/mkcert-style or `*.local`), `Origin` checks, max-clients cap.
- **Every request is authenticated + scoped**, including non-browser clients — there is no ambient trust for being on the LAN. **Per-method scopes** (§6 capability subset); **terminal is read-only by default**, input requires an explicit elevated grant; destructive commands require on-device confirm. Treat every inbound frame as hostile (CSRF-style command attempts, pty-input abuse) and validate against the command schema.
- **Off-LAN = bring-your-own network (DECIDED — user, cmux-style):** for WAN, the user runs their **own Tailscale** (or SSH/VPN). **Pine does NOT operate a hosted relay/bridge and has NO login/accounts.** This is a firm product decision, not a "later" — it drops the entire relay tier and its OAuth/device-cloud complexity. Cloudflare Tunnel/ngrok are user's-choice, undocumented-by-us alternatives.
- **Pairing = a menu action.** The user opens a "Connect a device / Pair phone" item somewhere in the app; Pine shows a QR (LAN URL + one-time pairing secret); the phone scans it on the same network (or over the user's Tailscale) and is issued a per-device, revocable credential. After pairing they communicate directly, desktop ↔ phone, no third party.
- **Superseded:** the earlier "outbound relay (Claude-Code-Remote-Control shape)" option is **removed** per the above — no cloud rendezvous, no account.

### C.2 Mobile web UI
- **Terminal mirror:** xterm.js + FitAddon in the browser ↔ **binary WebSocket** to the pane's pty. `0x00`-prefixed control frames for resize/metadata; `pty.resize()` → SIGWINCH. **Debounce** resize (mobile keyboard + `ResizeObserver` bursts). Keep pty alive across drops; **scrollback ring buffer** replay on reconnect; **ping/pong heartbeat + exponential backoff**. Touch key-bar (Esc/Tab/Ctrl/arrows).
- **Board view + command drive:** render the Kanban; answer/inject to agents; run saved commands/skills; push notifications when an agent finishes / needs input.

### C.3 Security
No inbound ports in the relay tier; TLS every hop; account/token auth so a known URL alone never grants access; least-privilege pty (read-only default option, scope to one workDir); reuse §6 broker.

---

## 6. Cross-cutting — Security & Permission Broker (Codex F2, Critical)

The control socket + gateway are a **remote-code-execution surface** (`ARCHITECTURE.md` §3.1, §9). **`0600` on the socket is necessary but nowhere near sufficient** — it only stops *other Unix users*; it does nothing against the real threat model: another same-user process, a compromised shell, an npm `postinstall`, or an agent subprocess that reads env or scans `$XDG_RUNTIME_DIR` and connects. So access is **credential-based, not reachability-based**:

- **Identity = proof of a per-pane token.** Each pane gets an unguessable `paneToken` (A.4), handed *only* to that pane's own shell via `PINE_TOKEN`. `hello` must present it; the connection's identity and capability set derive from *which pane's token was proven*. No token ⇒ null capabilities. **No socket auto-discovery grants privilege** — a client that finds the socket but lacks a token can do nothing.
- **Capabilities.** Every privileged op (fs, network, shell/pty-write, git, agent-control, destructive) is a named **capability**; each command declares the capabilities it needs (A.0.1). The broker checks the connection's set on **every** call and validates args against the command's `argsSchema` before dispatch. One choke point in `main`.
- **Tiers.** *Local pane agents:* a scoped set (e.g. can drive its own pane, read board; **not** kill other panes without an elevated cap). *Phone:* a strict subset, **read-only by default**, destructive ⇒ explicit on-device confirm (§C.3). *Plugins (future):* manifest-declared.
- **Cross-pane actions require elevation.** `pine send <otherPane>` / killing another pane / handoff into another agent are **not** default caps — they need an explicit grant, because "inject into another pane's stdin" is code-exec in that pane.
- **Audit log in v1 (not "later").** Every privileged call + every denial is appended to an audit log from day one — it is the only way to reason about this surface. Rate limits + revocation follow.
- **Destructive verbs gated regardless of caller.**

### 6.1 Threat-model decision + capability grant store (DECIDED 2026-07-03 — Codex R2)
**Posture (decided, see §0.3):** a process inside a pane is trusted *at that pane's scope*. `PINE_TOKEN` provides **identity + confinement**, not defense against a pane's own children. So:
- **Grant store:** capability grants live in a main-owned policy table (persisted under `app.getPath('userData')`, beside settings), keyed by `paneToken`. **Defaults:** a fresh pane gets `{drive-self, read-board}` only. **Elevated caps** (`send-other-pane`, `kill-pane`, `workspace-wide`, `destructive`, `phone`) are **off by default** and granted per-pane by an explicit user action (a prompt / settings toggle), with revocation and an audit trail.
- **Elevation:** a command needing a cap the caller lacks returns a typed `needs-elevation` error the UI can turn into a grant prompt — it never silently succeeds or silently no-ops.
- If the user instead wants the heavier "defend a pane from its own subprocesses" model, that's a separate, larger workstream (per-pane process sandbox) — flagged, not assumed.

---

## 7. File-level change map (grounded)

**New:**
- `src/main/controlServer.ts` — socket server + JSON-RPC (clone `lsp.ts` shape).
- `src/main/idRegistry.ts` — durable external-id ⇄ pane/session/window bijection.
- `src/main/bus/` — `store.ts` (SQLite), `board.ts` (per-repo file), `protocol.ts`, `mcp.ts`.
- `src/main/gateway/` — LAN server, pairing, pty-stream bridge (Phase C).
- `src/cli/index.ts` — the `pine` binary (separate build target).
- `src/renderer/panels/Kanban/` + `src/renderer/stores/kanbanStore.ts`.
- `.claude/skills/pine-bus/` — agent skill.

**Prerequisite refactors (A.0 — do first):**
- `src/renderer/commands/registry.ts` — `CommandDef` gains `argsSchema`/`resultSchema`/`capabilities`/`target`; `exec` returns `{ok,result,error}` (A.0.1).
- `src/main/index.ts` `PtyEntry`/`pty:*` (`:36-59,:230-303`) — single-`wc` → `Set<Subscriber>` with cursors, refcount, seq'd ring buffer, read-only subscribers (A.0.2).
- Renderer stores/components — emit pane/session lifecycle events to main (A.0.3).

**Touch:**
- `src/main/index.ts` — register/stop control server (`:336-341`,`:348-358`); per-window registry + stash primary window (`:121-145`); env inject `PINE_TOKEN`/`PINE_PANE_ID`/`PINE_SOCKET` at `pty:attach` (`:254-260`); `command:exec` + `terminal:state` + `kanban:*` handlers.
- `src/preload/index.ts` + `src/shared/types.ts` — new bridge surface (`command:invoke`, `terminal:state`, `kanban:*`).
- `src/renderer/commands/builtins.ts` — v1 command surface; `command:invoke` adapter.
- `src/main/shellIntegration.ts` — confirm `PINE_*` env alongside `ZDOTDIR` injection.
- `package.json` — `"bin": {"pine": …}`; CLI build script; add `better-sqlite3` (or `node:sqlite`) dep.
- **Refactor guard:** introduce a shared `currentTarget` accessor so `kanbanStore` doesn't deepen the `sessionsStore`↔`layoutStore` cycle.

---

## 8. Risks & open decisions
- **RCE surface** (socket+gateway) → per-session scope, capability broker, destructive-gate, QR/token, opt-in remote.
- **Require-cycle** deepening with a third store → shared accessor / one-way import (§2.4).
- **Stable ids across restart** → Phase A guarantees within-run; cross-restart needs session-persistence (M3·Phase 12) — flagged, not blocking.
- **Terminal-state mirror** cost/duplication → chose renderer→main push (A.5); revisit if push volume high.
- **SQLite native module vs `node:sqlite`** → decide at Phase B (ABI-rebuild concerns mirror node-pty, §9).
- **Kanban file format** (JSON vs md-with-frontmatter) → JSON for machine-writeability; render human-friendly.
- **MCP transport** (stdio vs loopback HTTP) → stdio first (locality), HTTP if a shared hub is wanted.

## 9. Phasing (tightened per Codex F9 — prove the spine before layering products)

**A-MVP — the smallest provable spine (this is what the implementation plan should cover).** Nothing downstream is worth designing in detail until this is real and stable:
1. A.0.1 command-contract upgrade (args/result/capability/target schemas).
2. A.0.2 PTY multi-subscriber refactor + A.0.3 lifecycle events + A.4 id registry/token.
3. Authenticated control socket (A.1) + `pine` CLI (A.2) + command bridge with explicit target (A.3).
4. A minimal, mostly **non-destructive** verb set: `command.list`, `pane.list`, `pane.focus`, `pane.split`, `terminal.run` (behind the `shell` cap). `pty.write`/`pine send` cross-pane stays **gated** (§6).
5. Terminal-state mirror (A.5) for `pane.info`.
→ **Exit criterion:** an agent in a pane drives its own pane via `pine`, `pine commands --json` introspects, capability denials and audit log work, and the PTY refactor holds under attach/detach/remount. *Only then* proceed.

**Deferred until A-MVP is proven** (designed here as outline, not built in parallel):
- **B (bus + kanban)** — order: live-inject (gated) → board projection + panel → durable SQLite bus + handoff state machine → MCP surface + Claude skill. Leases/handoff are the *last* increment, not the first.
- **C (phone)** — LAN gateway (off by default) + pairing + read-only pty mirror → board/command drive → (later) outbound relay.

B and C both depend only on a *proven* A. Each increment is independently demoable; cut freely.
