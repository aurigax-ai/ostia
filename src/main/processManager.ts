/**
 * `process` toolbelt service (agent-toolbelt #3, capability 'process' — elevated: spawning
 * and killing background processes is more powerful than firing a notification). Tracks
 * background child processes an agent starts (e.g. dev servers) via `child_process.spawn`
 * (NOT node-pty — these are headless workers, not interactive terminals) with `{ shell: true }`
 * so a plain command string works. Merges stdout+stderr into a `PtyRingBuffer` per process so
 * `process.output` can replay history the same way pty attach/reconnect does.
 *
 * Persistence: the process TABLE (metadata only — id/name/cmd/cwd/status/pid/exitCode/
 * startedAt) is durable via `jsonStore`, so `process.list` shows history across app restarts.
 * The live `ChildProcess`/`PtyRingBuffer` are NOT persisted (can't survive a restart); any
 * entry loaded at startup with status 'running' is relabeled 'exited' — its child died with
 * the previous app instance, so lying about liveness would be worse than losing that detail.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { registerControlMethod } from './controlServer'
import { workDirForSession } from './index'
import { loadJson, saveJson, storePath } from './jsonStore'
import { PtyRingBuffer } from './ptyRingBuffer'

export interface ProcEntry {
  id: string
  name: string
  cmd: string
  cwd: string
  status: 'running' | 'exited' | 'killed'
  pid?: number
  exitCode?: number
  startedAt: string
  output: PtyRingBuffer
  child?: ChildProcess
}

/** The durable subset of `ProcEntry` — no live `child`/`output`, just the table row. */
type ProcMeta = Omit<ProcEntry, 'output' | 'child'>

const procs = new Map<string, ProcEntry>()
let counter = 0

function metaPath(): string {
  return storePath('processes', 'global')
}

function toMeta(entry: ProcEntry): ProcMeta {
  const { id, name, cmd, cwd, status, pid, exitCode, startedAt } = entry
  return { id, name, cmd, cwd, status, pid, exitCode, startedAt }
}

/** Persist the metadata table (not the live child/ring) — called on every state change. */
function persist(): void {
  saveJson(metaPath(), [...procs.values()].map(toMeta))
}

/** Load prior entries at startup; anything 'running' is orphaned (its child died with the app). */
function loadPersisted(): void {
  const rows = loadJson<ProcMeta[]>(metaPath(), [])
  for (const row of rows) {
    procs.set(row.id, {
      ...row,
      status: row.status === 'running' ? 'exited' : row.status,
      output: new PtyRingBuffer(),
    })
  }
}

/** Look an entry up by id, falling back to a name match. */
function resolveEntry(idOrName: string): ProcEntry | undefined {
  return procs.get(idOrName) ?? [...procs.values()].find((p) => p.name === idOrName)
}

function toInfoShape(entry: ProcEntry) {
  const { id, name, cmd, cwd, status, pid, exitCode, startedAt } = entry
  return { id, name, cmd, cwd, status, pid, exitCode, startedAt }
}

/** Spawn `cmd` under a shell and wire up output capture + exit bookkeeping. */
function spawnEntry(
  id: string,
  name: string,
  cmd: string,
  cwd: string,
  env?: Record<string, string>,
): ProcEntry {
  const child = spawn(cmd, { shell: true, cwd, env: { ...process.env, ...env } })
  const entry: ProcEntry = {
    id,
    name,
    cmd,
    cwd,
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
      const entry = spawnEntry(id, name ?? id, cmd, resolvedCwd, env)
      procs.set(id, entry)
      persist()
      return { id: entry.id, name: entry.name, pid: entry.pid }
    },
  })

  registerControlMethod('process.list', {
    cap: 'process',
    handler: () => [...procs.values()].map(toInfoShape),
  })

  registerControlMethod('process.info', {
    cap: 'process',
    handler: (params) => {
      const { id } = (params ?? {}) as { id: string }
      const entry = resolveEntry(id)
      return entry ? toInfoShape(entry) : null
    },
  })

  registerControlMethod('process.output', {
    cap: 'process',
    handler: (params) => {
      const { id, sinceCursor } = (params ?? {}) as { id: string; sinceCursor?: number }
      const entry = resolveEntry(id)
      if (!entry) return { data: '', cursor: 0, dropped: false }
      return entry.output.since(sinceCursor ?? 0)
    },
  })

  registerControlMethod('process.kill', {
    cap: 'process',
    handler: (params) => {
      const { id, signal } = (params ?? {}) as { id: string; signal?: NodeJS.Signals }
      const entry = resolveEntry(id)
      if (!entry) return { ok: false }
      entry.child?.kill(signal ?? 'SIGTERM')
      entry.status = 'killed'
      persist()
      return { ok: true }
    },
  })

  registerControlMethod('process.restart', {
    cap: 'process',
    handler: (params) => {
      const { id } = (params ?? {}) as { id: string }
      const entry = resolveEntry(id)
      if (!entry) throw new Error(`unknown process '${id}'`)
      if (entry.status === 'running') {
        try {
          entry.child?.kill('SIGTERM')
        } catch {
          // already gone
        }
      }
      const fresh = spawnEntry(entry.id, entry.name, entry.cmd, entry.cwd)
      procs.set(entry.id, fresh)
      persist()
      return { id: fresh.id }
    },
  })
}

/** Kill every still-running child (app quit) — best-effort, doesn't wait for exit. */
export function killAllProcesses(): void {
  for (const entry of procs.values()) {
    if (entry.status === 'running') {
      try {
        entry.child?.kill('SIGTERM')
      } catch {
        // already gone
      }
    }
  }
}
