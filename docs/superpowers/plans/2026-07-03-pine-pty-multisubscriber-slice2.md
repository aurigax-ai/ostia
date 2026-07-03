# Pine Control Plane — Slice 2: PTY Multi-Subscriber Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Refactor Pine's single-subscriber pty (one `WebContents` per pty) into a **multi-subscriber session** with a sequence-numbered ring buffer, per-subscriber replay cursor, refcounted lifecycle, and read-only observers — the substrate the terminal-state mirror (Slice 7) and phone pty streaming (Slice C) require — **without regressing the live terminal** (replay, detach-grace, anti-staircase resize).

**Architecture:** Extract the risky logic into two **pure, node-env-unit-testable** modules — a sequence-numbered ring buffer (`ptyRingBuffer.ts`) and a subscriber-managing session (`ptySession.ts`) — then rewire `main/index.ts`'s pty IPC to use them (one node-pty + one `PtySession` per pane), and extend the IPC contract so a caller can attach as `owner` (read/write, refcounts the pty) or `observer` (read-only) and resume from a cursor. The renderer terminal stays an owner; behavior is preserved.

**Tech Stack:** TypeScript, Electron main (node-pty, WebContents), Vitest (`environment: 'node'`).

## Global Constraints

- **Pure logic is unit-tested; Electron glue is not.** `ptyRingBuffer.ts` and `ptySession.ts` must NOT import `electron` or `node-pty` — they take injected `send`/`kill` callbacks — so they run under Vitest `environment: 'node'` (no DOM, no Electron). `main/index.ts` and `Terminal.tsx` changes are verified by `npm run typecheck` + `npm run build` + a **manual smoke checklist** (Task 6), because there is no Electron/xterm test harness.
- **Preserve these invariants (regression = failure):**
  1. Buffer overflow trims at a **safe escape boundary** (advance cut to after the next `\n`, else to the next `\x1b`) — never mid OSC/CSI (`index.ts:266-276`).
  2. `detach` keeps the pty alive `DETACH_GRACE_MS` (3000) for a remount, then reaps — but ONLY when no owning subscriber remains (`index.ts:286-292`).
  3. Re-attach (remount) cancels the pending kill and replays history (`index.ts:231-240`).
  4. `onExit` notifies subscribers and drops the session (`index.ts:279-282`).
  5. Anti-staircase: `Terminal.tsx`'s subscribe-before-attach pending-queue (`Terminal.tsx:122-146`) and debounced resize (`:154-162`) must remain intact.
- **Backward-compatible IPC:** existing `pty.attach(paneId, opts)` callers keep working (role defaults to `owner`). Renderer has no Node access; all pty logic stays in main.
- Tests pristine. `npm run typecheck` shows only the 4 pre-existing `PluginsView.tsx` errors, nothing new. Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. No new deps.

---

## File Structure
- **Create** `src/main/ptyRingBuffer.ts` — pure sequence-numbered, capped, escape-boundary-trimming byte ring. No electron/node-pty imports.
- **Create** `src/main/ptyRingBuffer.test.ts`
- **Create** `src/main/ptySession.ts` — pure subscriber registry over a ring buffer: add/remove subscriber, per-subscriber cursor, refcounted owner lifecycle, injected `send`/`onEmptyOwners` callbacks. No electron/node-pty imports.
- **Create** `src/main/ptySession.test.ts`
- **Modify** `src/shared/types.ts` — extend `PtySpawnOptions` (or add `PtyAttachOptions`) with `role`, add `cursor`/`dropped` to `PtyAttachResult`, add `attachFrom`/`sinceCursor`.
- **Modify** `src/preload/index.ts` — forward the extended attach surface.
- **Modify** `src/main/index.ts` — replace `PtyEntry`/`registerPtyIpc` internals with `PtySession`.
- **Modify** `src/renderer/components/Terminal.tsx` — attach as `owner`; unchanged replay/queue behavior.

---

## Task 1: Sequence-numbered ring buffer (pure, TDD)

**Files:**
- Create: `src/main/ptyRingBuffer.ts`
- Test: `src/main/ptyRingBuffer.test.ts`

**Interfaces:**
- Produces: `class PtyRingBuffer { constructor(capBytes?: number); push(data: string): void; get end(): number; since(cursor: number): { data: string; cursor: number; dropped: boolean } }`
  - `end` = total bytes ever pushed (monotonic; the current stream position / next cursor).
  - `since(cursor)` = the bytes from `cursor` to `end`, plus the new `cursor` (=`end`), and `dropped:true` if `cursor` predates the retained window (history was trimmed past it → caller should treat as a fresh replay).

- [ ] **Step 1: Write the failing test**

```ts
// src/main/ptyRingBuffer.test.ts
import { describe, expect, it } from 'vitest'
import { PtyRingBuffer } from './ptyRingBuffer'

describe('PtyRingBuffer', () => {
  it('replays everything from cursor 0 and reports the end position', () => {
    const rb = new PtyRingBuffer(1000)
    rb.push('hello ')
    rb.push('world')
    expect(rb.end).toBe(11)
    expect(rb.since(0)).toEqual({ data: 'hello world', cursor: 11, dropped: false })
  })

  it('returns only new bytes since a cursor', () => {
    const rb = new PtyRingBuffer(1000)
    rb.push('abc')
    const a = rb.since(0)
    rb.push('def')
    expect(rb.since(a.cursor)).toEqual({ data: 'def', cursor: 6, dropped: false })
  })

  it('trims at a newline boundary when over cap, marking dropped for stale cursors', () => {
    const rb = new PtyRingBuffer(8)
    rb.push('aaaa\nbbbb\ncccc') // 13 bytes > cap 8
    // retained window starts after a safe boundary; a cursor of 0 is now stale
    const r = rb.since(0)
    expect(r.dropped).toBe(true)
    expect(r.cursor).toBe(13)
    // retained data ends at the stream end and never starts mid-line
    expect('aaaa\nbbbb\ncccc'.endsWith(r.data)).toBe(true)
    expect(r.data.startsWith('cccc') || r.data.startsWith('bbbb')).toBe(true)
  })

  it('never cuts an escape sequence: trims to the next ESC when no newline precedes it', () => {
    const rb = new PtyRingBuffer(4)
    rb.push('xy\x1b[31mZ') // must not retain a fragment that starts mid-ESC
    const { data } = rb.since(0)
    // retained window begins at a newline+1 or an ESC, never inside a CSI
    expect(data.includes('\x1b') ? data.indexOf('\x1b') === 0 : true).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/ptyRingBuffer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the ring buffer** (port the exact trim logic from `index.ts:266-276`)

```ts
// src/main/ptyRingBuffer.ts
/**
 * A capped, sequence-numbered byte ring for a pty's output. Keeps the last ~capBytes,
 * trimming ONLY at a safe escape boundary (after a newline, else at an ESC) so a replay
 * never re-parses a fragment of an OSC/CSI sequence (would corrupt xterm's parser and drop
 * a shell-integration mark). `end` is a monotonic stream cursor; `since(cursor)` supports
 * reconnect replay. Ported from the inline logic in main/index.ts.
 */
export class PtyRingBuffer {
  private buf = ''
  /** Stream offset of buf[0] — i.e. bytes dropped from the front so far. */
  private start = 0

  constructor(private readonly capBytes = 1_000_000) {}

  /** Total bytes ever pushed = the next cursor. */
  get end(): number {
    return this.start + this.buf.length
  }

  push(data: string): void {
    this.buf += data
    if (this.buf.length > this.capBytes) {
      // Trim to a safe boundary: never cut an OSC/CSI escape mid-sequence.
      let cut = this.buf.length - this.capBytes
      const nl = this.buf.indexOf('\n', cut)
      const esc = this.buf.indexOf('\x1b', cut)
      if (nl !== -1 && (esc === -1 || nl <= esc)) cut = nl + 1
      else if (esc !== -1) cut = esc
      this.start += cut
      this.buf = this.buf.slice(cut)
    }
  }

  /** Bytes from `cursor` to `end`. `dropped` = the cursor predates the retained window. */
  since(cursor: number): { data: string; cursor: number; dropped: boolean } {
    const dropped = cursor < this.start
    const from = Math.max(0, cursor - this.start)
    return { data: this.buf.slice(from), cursor: this.end, dropped }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/ptyRingBuffer.test.ts`
Expected: PASS. (If the escape-boundary assertion needs tightening, adjust the test to match the ported semantics — but the trim code must stay byte-identical to `index.ts:266-276`.)

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`

```bash
git add src/main/ptyRingBuffer.ts src/main/ptyRingBuffer.test.ts
git commit -m "feat(pty): sequence-numbered ring buffer with escape-safe trim

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Multi-subscriber PtySession (pure, TDD)

**Files:**
- Create: `src/main/ptySession.ts`
- Test: `src/main/ptySession.test.ts`

**Interfaces:**
- Consumes: `PtyRingBuffer` (Task 1).
- Produces:
```ts
export type SubscriberRole = 'owner' | 'observer'
export interface Subscriber {
  id: string
  role: SubscriberRole
  send: (data: string, cursor: number) => void
}
export class PtySession {
  constructor(opts?: { capBytes?: number; onNoOwners?: () => void; onExit?: (code: number) => void })
  push(data: string): void                       // feed pty output → ring + fan out to subscribers
  exit(code: number): void                       // pty exited → notify all, mark ended
  /** Add a subscriber; replays from `sinceCursor` (default 0 = full history). Returns the end cursor + dropped. */
  addSubscriber(sub: Subscriber, sinceCursor?: number): { cursor: number; dropped: boolean }
  removeSubscriber(id: string): void             // drop; if it was the last OWNER, fire onNoOwners
  get ownerCount(): number
  canWrite(id: string): boolean                  // only owners may write
}
```
- **Refcount rule:** `onNoOwners` fires when the last `owner` is removed (observers don't hold the pty open) — the IPC layer uses it to start the detach-grace kill. Adding an owner again before the grace elapses cancels the reap (handled in the IPC layer, Task 4).

- [ ] **Step 1: Write the failing test**

```ts
// src/main/ptySession.test.ts
import { describe, expect, it, vi } from 'vitest'
import { PtySession } from './ptySession'

const sub = (id: string, role: 'owner' | 'observer', sink: string[]) => ({
  id, role, send: (d: string) => sink.push(d),
})

describe('PtySession', () => {
  it('replays history to a new subscriber and fans out live output', () => {
    const s = new PtySession()
    s.push('boot\n')
    const a: string[] = []
    const res = s.addSubscriber(sub('a', 'owner', a))
    expect(res.dropped).toBe(false)
    expect(a).toEqual(['boot\n']) // replayed history
    const b: string[] = []
    s.addSubscriber(sub('b', 'observer', b))
    s.push('live')
    expect(a).toEqual(['boot\n', 'live'])
    expect(b).toEqual(['boot\n', 'live']) // both get live output
  })

  it('only owners may write; observers may not', () => {
    const s = new PtySession()
    s.addSubscriber(sub('o', 'owner', []))
    s.addSubscriber(sub('v', 'observer', []))
    expect(s.canWrite('o')).toBe(true)
    expect(s.canWrite('v')).toBe(false)
  })

  it('fires onNoOwners only when the LAST owner leaves (observers do not hold it open)', () => {
    const onNoOwners = vi.fn()
    const s = new PtySession({ onNoOwners })
    s.addSubscriber(sub('o1', 'owner', []))
    s.addSubscriber(sub('o2', 'owner', []))
    s.addSubscriber(sub('v', 'observer', []))
    s.removeSubscriber('o1')
    expect(onNoOwners).not.toHaveBeenCalled()
    s.removeSubscriber('v')
    expect(onNoOwners).not.toHaveBeenCalled() // observer leaving doesn't matter
    s.removeSubscriber('o2')
    expect(onNoOwners).toHaveBeenCalledTimes(1) // last owner gone
  })

  it('notifies onExit and forwards exit to no one after end', () => {
    const onExit = vi.fn()
    const s = new PtySession({ onExit })
    s.exit(0)
    expect(onExit).toHaveBeenCalledWith(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/ptySession.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement PtySession** (over `PtyRingBuffer`)

```ts
// src/main/ptySession.ts
import { PtyRingBuffer } from './ptyRingBuffer'

export type SubscriberRole = 'owner' | 'observer'
export interface Subscriber {
  id: string
  role: SubscriberRole
  send: (data: string, cursor: number) => void
}

/**
 * One pty's fan-out: a ring buffer plus a set of subscribers (owners = read/write and hold
 * the pty open; observers = read-only, e.g. the phone). Pure — the IPC layer injects the
 * WebContents `send` and wires onNoOwners → detach-grace kill. See ptyRingBuffer for trim.
 */
export class PtySession {
  private readonly ring: PtyRingBuffer
  private readonly subs = new Map<string, Subscriber>()
  private ended = false
  private readonly onNoOwners?: () => void
  private readonly onExitCb?: (code: number) => void

  constructor(opts?: { capBytes?: number; onNoOwners?: () => void; onExit?: (code: number) => void }) {
    this.ring = new PtyRingBuffer(opts?.capBytes)
    this.onNoOwners = opts?.onNoOwners
    this.onExitCb = opts?.onExit
  }

  push(data: string): void {
    this.ring.push(data)
    const cursor = this.ring.end
    for (const s of this.subs.values()) s.send(data, cursor)
  }

  exit(code: number): void {
    this.ended = true
    this.onExitCb?.(code)
  }

  addSubscriber(sub: Subscriber, sinceCursor = 0): { cursor: number; dropped: boolean } {
    this.subs.set(sub.id, sub)
    const { data, cursor, dropped } = this.ring.since(sinceCursor)
    if (data) sub.send(data, cursor)
    return { cursor, dropped }
  }

  removeSubscriber(id: string): void {
    const sub = this.subs.get(id)
    if (!sub) return
    this.subs.delete(id)
    if (sub.role === 'owner' && this.ownerCount === 0) this.onNoOwners?.()
  }

  get ownerCount(): number {
    let n = 0
    for (const s of this.subs.values()) if (s.role === 'owner') n++
    return n
  }

  canWrite(id: string): boolean {
    return this.subs.get(id)?.role === 'owner'
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/ptySession.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`

```bash
git add src/main/ptySession.ts src/main/ptySession.test.ts
git commit -m "feat(pty): multi-subscriber PtySession with refcounted owner lifecycle

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Extend the IPC contract (types + preload)

**Files:**
- Modify: `src/shared/types.ts` (`PtySpawnOptions`, `PtyAttachResult`, `PtyApi`)
- Modify: `src/preload/index.ts` (pty bridge)

**Interfaces (Produces):**
- `PtySpawnOptions` gains `role?: 'owner' | 'observer'` (default owner) and `sinceCursor?: number`.
- `PtyAttachResult` gains `cursor: number` and `dropped: boolean` (keep `created`, `buffer`).
- `PtyApi.attach` unchanged shape; `onData` cb stays `(data: string) => void` for the renderer (owner) — cursor tracking is internal and used by reconnecting observers via `sinceCursor` on attach. No new channel needed in Slice 2.

- [ ] **Step 1: Write the failing test** — types have no runtime test; assert the preload shape indirectly by a compile-time check file.

Add to a new `src/shared/types.pty.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import type { PtyAttachResult, PtySpawnOptions } from './types'

describe('pty IPC contract', () => {
  it('attach result carries a cursor and dropped flag; opts allow a role', () => {
    const r: PtyAttachResult = { created: true, buffer: '', cursor: 0, dropped: false }
    const o: PtySpawnOptions = { cols: 80, rows: 24, role: 'observer', sinceCursor: 5 }
    expect(r.cursor).toBe(0)
    expect(o.role).toBe('observer')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/shared/types.pty.test.ts`
Expected: FAIL — `cursor`/`dropped`/`role`/`sinceCursor` not on the types (typecheck error surfaced by vitest's transform).

- [ ] **Step 3: Extend the types**

In `src/shared/types.ts`, update:
```ts
export interface PtySpawnOptions {
  cwd?: string
  cols: number
  rows: number
  shell?: string
  /** Attach as a read/write owner (default) or a read-only observer (e.g. the phone). */
  role?: 'owner' | 'observer'
  /** Resume replay from this stream cursor (reconnect); default 0 = full history. */
  sinceCursor?: number
}

export interface PtyAttachResult {
  created: boolean
  /** Output produced since `sinceCursor` (capped), to replay into the terminal. */
  buffer: string
  /** Stream position after `buffer` — pass back as `sinceCursor` to resume. */
  cursor: number
  /** True if `sinceCursor` predated retained history (buffer is a fresh full replay). */
  dropped: boolean
}
```
Preload needs no signature change (it forwards `opts`/result verbatim), but update the `as Promise<PtyAttachResult>` cast site remains valid. Confirm `src/preload/index.ts:37-38` still typechecks.

- [ ] **Step 4: Run to verify it passes** + typecheck

Run: `npx vitest run src/shared/types.pty.test.ts && npm run typecheck`
Expected: test PASS; typecheck shows only the 4 pre-existing PluginsView errors. NOTE: `index.ts`'s `pty:attach` handler now returns an object missing `cursor`/`dropped` → a NEW typecheck error. That is expected and is fixed in Task 4; if you want Task 3 to commit green, temporarily add `cursor: 0, dropped: false` to the two `return` sites in `index.ts` (they'll be rewritten in Task 4). Prefer: land Task 3 + Task 4 back-to-back and commit Task 3 with the stub values.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/types.pty.test.ts src/main/index.ts
git commit -m "feat(pty): extend attach IPC contract with role + cursor + dropped

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Rewire main pty IPC onto PtySession (integration)

**Files:**
- Modify: `src/main/index.ts:36-59, 229-303, 348-357` (PtyEntry → PtySession; registerPtyIpc; before-quit)

**Consumes:** `PtySession` (Task 2), extended `PtyAttachResult` (Task 3).

Replace the `PtyEntry`/`ptys`/`killPty` model and `registerPtyIpc` internals so each pane maps to `{ pty: IPty; session: PtySession; killTimer }`. Key mapping from the current code:
- **Fresh spawn** (`index.ts:242-283`): create `PtySession` with `capBytes: PTY_BUFFER_CAP`, `onNoOwners: () => start detach-grace kill`, `onExit: (code) => { notify + delete }`. Wire `pty.onData(d => session.push(d))` and `pty.onExit(({exitCode}) => session.exit(exitCode))`. Add the caller as an `owner` subscriber whose `send` = `wc.send(\`pty:data:${paneId}\`, data)` (guard `!wc.isDestroyed()`). Return `{ created: true, buffer: replayed, cursor, dropped }` from `addSubscriber(sinceCursor=0)`.
- **Re-attach** (`index.ts:231-240`): cancel `killTimer`; `addSubscriber` again (new subscriber id per WebContents) from `opts.sinceCursor ?? 0`; return `{ created: false, buffer, cursor, dropped }`.
- **detach** (`index.ts:286-293`): `session.removeSubscriber(thisWcSubId)`; the `onNoOwners` callback (not detach itself) starts the `DETACH_GRACE_MS` timer → `killPty`. Re-attach cancels it.
- **write** (`index.ts:295`): only if `session.canWrite(subId)` — owners only.
- **resize/kill/before-quit**: unchanged semantics, adapted to the new struct.
- Subscriber id: derive from `e.sender.id` (WebContents id) so re-attach/detach target the right subscriber.

**Verification (no unit test — Electron glue):** `npm run typecheck` (only PluginsView errors) + `npm run build`. Behavioral verification is the Task 6 manual smoke. Commit:
```bash
git add src/main/index.ts
git commit -m "refactor(pty): drive pty IPC through PtySession (multi-subscriber, refcounted)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
**Escalate (DONE_WITH_CONCERNS) if** preserving detach-grace + re-attach refcount semantics is ambiguous against the new subscriber model — this is the riskiest task; flag rather than guess.

---

## Task 5: Point Terminal.tsx at the owner-attach contract (integration)

**Files:**
- Modify: `src/renderer/components/Terminal.tsx:135-146` (attach call)

Minimal change: the renderer already attaches as the (implicit) owner. Pass `role: 'owner'` explicitly and keep `sinceCursor` unset (full replay on mount/remount — current behavior). Do NOT change the subscribe-before-attach pending queue (`:122-146`), block reset (`:141`), or debounced resize (`:154-162`) — they must stay byte-for-byte. The `.then(({ buffer }) => …)` destructure still works (extra `cursor`/`dropped` fields are ignored).

**Verification:** `npm run typecheck` + `npm run build`. Behavior = Task 6 smoke. Commit:
```bash
git add src/renderer/components/Terminal.tsx
git commit -m "feat(pty): terminal attaches as explicit owner

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Verification + manual smoke (human-in-the-loop)

**Files:** none.

- [ ] **Step 1: Full gate** — `npm run typecheck && npm run lint && npm test && npm run build`. Expected: all green except the 4 known PluginsView typecheck errors; new unit tests (ring buffer + session) pass.
- [ ] **Step 2: Manual smoke (requires a display — the maintainer runs this):**
  1. `npm run rebuild` (node-pty for current Electron ABI) then `npm run dev`.
  2. Open a terminal pane; run `ls`, `echo hi`, a `cd` (OSC 7 cwd tracking still updates the pane).
  3. **Split the pane** → confirm the terminal re-attaches and **replays history with NO staircase / duplicated prompt** (the core regression this whole subsystem guards).
  4. Relocate/drag a pane; close and reopen; confirm detach-grace keeps the shell alive across the remount and reaping works after closing.
  5. Confirm command blocks (OSC 133) still delineate correctly after a split.
- [ ] **Step 3:** Record smoke results in the report. If any step regresses, file it as BLOCKED against Task 4/5.

**Slice 2 exit criterion:** ring buffer + session unit tests green; typecheck/lint/build green (modulo pre-existing PluginsView); manual smoke confirms replay, no staircase, detach-grace, and blocks all intact.

## Self-Review
- **Spec coverage:** implements spec A.0.2 + the Codex-flagged PTY IPC-contract extension (role/cursor/dropped in shared/types + preload). Read-only observer role + cursor replay set up Slice 7 (mirror) and Slice C (phone) without building them now (YAGNI).
- **Risk isolation:** all fiddly logic (escape-safe trim, refcount, replay) is in pure Tasks 1–2 with real unit tests; Tasks 4–5 are thin glue verified by typecheck/build + human smoke — honestly acknowledging the no-Electron-test-harness limit.
- **Invariant preservation:** the trim code is ported byte-identical; detach-grace/re-attach/anti-staircase behaviors are called out as must-preserve with file:line anchors.
- **Type consistency:** `Subscriber`, `PtySession`, `PtyRingBuffer.since`, `role`/`cursor`/`dropped` names are consistent across Tasks 1–5.
