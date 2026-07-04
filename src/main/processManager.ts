/**
 * `process` toolbelt service (agent-toolbelt #3, capability 'process' — elevated: spawning
 * and killing background processes is more powerful than firing a notification). Tracks
 * background child processes an agent starts (e.g. dev servers) via `child_process.spawn`
 * (NOT node-pty — these are headless workers, not interactive terminals) with `{ shell: true }`
 * so a plain command string works. Merges stdout+stderr into a `PtyRingBuffer` per process so
 * `process.output` can replay history the same way pty attach/reconnect does.
 *
 * Persistence: the process TABLE (metadata only — id/name/cmd/cwd/status/pid/exitCode/
 * startedAt/sessionId) is durable via `jsonStore`, so `process.list` shows history across app
 * restarts. The live `ChildProcess`/`PtyRingBuffer` are NOT persisted (can't survive a
 * restart); any entry loaded at startup with status 'running' is relabeled 'exited' — its
 * child died with the previous app instance, so lying about liveness would be worse than
 * losing that detail. The persisted `cmd` is REDACTED (first whitespace token only) — the
 * full command is kept in memory only, so a secret passed as an argv token never lands on
 * disk; `process.list`/`info` still return the full in-memory `cmd` to an authorized caller.
 *
 * Access control: every entry remembers the `sessionId` that started it (the caller's
 * identity at `process.run` time). `process.list`/`info`/`output`/`kill`/`restart` only see
 * an entry belonging to the caller's own session, unless the caller holds the elevated
 * `'workspace-wide'` capability. A process the caller may not access is reported exactly the
 * same as one that doesn't exist — a typed `{ ok: false, error: 'not-found' }` — so probing
 * ids never reveals another session's processes.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import type { AuthedConn } from './controlAuth'
import { connHasCap } from './controlAuth'
import { registerControlMethod } from './controlServer'
import type { PaneIdentity } from './idRegistry'
import { loadJson, saveJson, storePath } from './jsonStore'
import { PtyRingBuffer } from './ptyRingBuffer'
import { workDirForSession } from './sessionRegistry'

export interface ProcEntry {
  id: string
  name: string
  cmd: string
  cwd: string
  sessionId: string
  status: 'running' | 'exited' | 'killed'
  pid?: number
  exitCode?: number
  startedAt: string
  output: PtyRingBuffer
  child?: ChildProcess
}

/** The durable subset of `ProcEntry` — no live `child`/`output`, just the table row. */
type ProcMeta = Omit<ProcEntry, 'output' | 'child'>

type MethodCtx = { identity: PaneIdentity; authed: AuthedConn }

/** A process the caller may not access is reported identically to one that doesn't exist. */
const NOT_FOUND = { ok: false, error: 'not-found' as const }

const procs = new Map<string, ProcEntry>()
let counter = 0

function metaPath(): string {
  return storePath('processes', 'global')
}

/** First whitespace-delimited token of `cmd` (roughly "the program name") — safe to persist. */
function redactCmd(cmd: string): string {
  return cmd.trim().split(/\s+/)[0] ?? ''
}

function toMeta(entry: ProcEntry): ProcMeta {
  const { id, name, cwd, sessionId, status, pid, exitCode, startedAt } = entry
  return { id, name, cmd: redactCmd(entry.cmd), cwd, sessionId, status, pid, exitCode, startedAt }
}

/** Persist the metadata table (not the live child/ring) — called on every state change. */
function persist(): void {
  saveJson(metaPath(), [...procs.values()].map(toMeta))
}

/** Load prior entries at startup; anything 'running' is orphaned (its child died with the app). */
function loadPersisted(): void {
  const rows = loadJson<ProcMeta[]>(metaPath(), [])
  let normalized = false
  for (const row of rows) {
    const wasRunning = row.status === 'running'
    if (wasRunning) normalized = true
    procs.set(row.id, {
      ...row,
      status: wasRunning ? 'exited' : row.status,
      output: new PtyRingBuffer(),
    })
    // Keep the id counter ahead of every persisted `proc-<n>` id so a restarted app never
    // reuses one (e.g. name-based lookups colliding across an old and a new entry).
    const match = /^proc-(\d+)$/.exec(row.id)
    if (match) counter = Math.max(counter, Number(match[1]))
  }
  // Persist the 'running' → 'exited' relabel immediately rather than waiting for the next
  // unrelated state change, so a crash right after startup doesn't re-show stale 'running'.
  if (normalized) persist()
}

/** Does `entry` belong to the caller, or does the caller hold cross-session access? */
function canAccess(entry: ProcEntry, ctx: MethodCtx): boolean {
  return entry.sessionId === ctx.identity.sessionId || connHasCap(ctx.authed, 'workspace-wide')
}

/**
 * Look an entry up by id, falling back to a name match — scoped to what `ctx` may access.
 * A name match prefers the caller's own session first (so two sessions sharing a process
 * name can't shadow each other) before falling back to a cross-session match, which only a
 * `'workspace-wide'` caller can reach. Returns `undefined` for "doesn't exist" and "exists
 * but not authorized" alike — callers must not distinguish the two in their response.
 */
function resolveAuthorized(idOrName: string, ctx: MethodCtx): ProcEntry | undefined {
  const byId = procs.get(idOrName)
  if (byId) return canAccess(byId, ctx) ? byId : undefined
  const candidates = [...procs.values()].filter((p) => p.name === idOrName)
  const own = candidates.find((p) => p.sessionId === ctx.identity.sessionId)
  if (own) return own
  return connHasCap(ctx.authed, 'workspace-wide') ? candidates[0] : undefined
}

function toInfoShape(entry: ProcEntry) {
  const { id, name, cmd, cwd, status, pid, exitCode, startedAt } = entry
  return { id, name, cmd, cwd, status, pid, exitCode, startedAt }
}

/**
 * Kill `child`'s whole process group on POSIX (it was spawned `detached: true`, making it
 * the group leader) so grandchildren — e.g. a dev server forked by the shell wrapper —
 * die too, instead of surviving as orphans. Falls back to killing just the tracked child
 * if the group kill fails, and on Windows (no POSIX process-group signalling) always kills
 * just the tracked child.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Group kill failed (e.g. already reaped) — fall back to the direct child below.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // already gone
  }
}

/** Spawn `cmd` under a shell and wire up output capture + exit bookkeeping. */
function spawnEntry(
  id: string,
  name: string,
  cmd: string,
  cwd: string,
  sessionId: string,
  env?: Record<string, string>,
): ProcEntry {
  // `detached: true` makes the child (the shell, since `shell: true`) its own process-group
  // leader, so `killTree` can signal the whole group (shell + whatever it forked) at once.
  const child = spawn(cmd, {
    shell: true,
    detached: true,
    cwd,
    env: { ...process.env, ...env },
  })
  const entry: ProcEntry = {
    id,
    name,
    cmd,
    cwd,
    sessionId,
    status: 'running',
    pid: child.pid,
    startedAt: new Date().toISOString(),
    output: new PtyRingBuffer(),
    child,
  }
  child.stdout?.on('data', (d: Buffer) => entry.output.push(d.toString()))
  child.stderr?.on('data', (d: Buffer) => entry.output.push(d.toString()))
  child.on('exit', (code) => {
    // A `process.kill` already set 'killed' synchronously; don't let the (later, async)
    // exit event stomp that back to 'exited'. Otherwise: plain exit → 'exited'.
    if (entry.status !== 'killed') entry.status = 'exited'
    entry.exitCode = code ?? -1
    persist()
  })
  return entry
}

export function registerProcessMethods(): void {
  loadPersisted()

  registerControlMethod('process.run', {
    cap: 'process',
    handler: (params, ctx) => {
      const { cmd, name, cwd, env } = (params ?? {}) as {
        cmd: string
        name?: string
        cwd?: string
        env?: Record<string, string>
      }
      const id = `proc-${++counter}`
      const resolvedCwd = cwd ?? workDirForSession(ctx.identity.sessionId) ?? process.cwd()
      const entry = spawnEntry(id, name ?? id, cmd, resolvedCwd, ctx.identity.sessionId, env)
      procs.set(id, entry)
      persist()
      return { id: entry.id, name: entry.name, pid: entry.pid }
    },
  })

  registerControlMethod('process.list', {
    cap: 'process',
    handler: (_params, ctx) => {
      const all = [...procs.values()]
      const visible = connHasCap(ctx.authed, 'workspace-wide')
        ? all
        : all.filter((p) => p.sessionId === ctx.identity.sessionId)
      return visible.map(toInfoShape)
    },
  })

  registerControlMethod('process.info', {
    cap: 'process',
    handler: (params, ctx) => {
      const { id } = (params ?? {}) as { id: string }
      const entry = resolveAuthorized(id, ctx)
      return entry ? toInfoShape(entry) : NOT_FOUND
    },
  })

  registerControlMethod('process.output', {
    cap: 'process',
    handler: (params, ctx) => {
      const { id, sinceCursor } = (params ?? {}) as { id: string; sinceCursor?: number }
      const entry = resolveAuthorized(id, ctx)
      if (!entry) return NOT_FOUND
      return entry.output.since(sinceCursor ?? 0)
    },
  })

  registerControlMethod('process.kill', {
    cap: 'process',
    handler: (params, ctx) => {
      const { id, signal } = (params ?? {}) as { id: string; signal?: NodeJS.Signals }
      const entry = resolveAuthorized(id, ctx)
      if (!entry) return NOT_FOUND
      if (entry.child) killTree(entry.child, signal ?? 'SIGTERM')
      entry.status = 'killed'
      persist()
      return { ok: true }
    },
  })

  registerControlMethod('process.restart', {
    cap: 'process',
    handler: (params, ctx) => {
      const { id } = (params ?? {}) as { id: string }
      const entry = resolveAuthorized(id, ctx)
      if (!entry) return NOT_FOUND
      if (entry.status === 'running' && entry.child) {
        killTree(entry.child, 'SIGTERM')
      }
      const fresh = spawnEntry(entry.id, entry.name, entry.cmd, entry.cwd, entry.sessionId)
      procs.set(entry.id, fresh)
      persist()
      return { id: fresh.id }
    },
  })
}

/** Kill every still-running child (app quit) — best-effort, doesn't wait for exit. */
export function killAllProcesses(): void {
  for (const entry of procs.values()) {
    if (entry.status === 'running' && entry.child) {
      killTree(entry.child, 'SIGTERM')
    }
  }
}
