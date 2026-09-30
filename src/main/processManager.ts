import { type ChildProcess, spawn } from 'node:child_process'
import type { AuthedConn } from './controlAuth'
import { connHasCap } from './controlAuth'
import { registerTargetableMethod } from './controlServer'
import type { PaneIdentity } from './idRegistry'
import { loadJson, saveJson, storePath } from './jsonStore'
import { PtyRingBuffer } from './ptyRingBuffer'
import { sandboxSpawnEnv } from './sandbox/spawnEnv'
import { workDirForWorkspace } from './workspaceRegistry'

export interface ProcEntry {
  id: string
  name: string
  cmd: string
  cwd: string
  workspaceId: string
  status: 'running' | 'exited' | 'killed'
  pid?: number
  exitCode?: number
  startedAt: string
  output: PtyRingBuffer
  child?: ChildProcess
  env?: Record<string, string>
}

type ProcMeta = Omit<ProcEntry, 'output' | 'child' | 'env'>

type MethodCtx = { identity: PaneIdentity; authed: AuthedConn }

const NOT_FOUND = { ok: false, error: 'not-found' as const }

const procs = new Map<string, ProcEntry>()
let counter = 0

function metaPath(): string {
  return storePath('processes', 'global')
}

function redactCmd(cmd: string): string {
  return cmd.trim().split(/\s+/)[0] ?? ''
}

function toMeta(entry: ProcEntry): ProcMeta {
  const { id, name, cwd, workspaceId, status, pid, exitCode, startedAt } = entry
  return { id, name, cmd: redactCmd(entry.cmd), cwd, workspaceId, status, pid, exitCode, startedAt }
}

function persist(): void {
  saveJson(metaPath(), [...procs.values()].map(toMeta))
}

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
    const match = /^proc-(\d+)$/.exec(row.id)
    if (match) counter = Math.max(counter, Number(match[1]))
  }
  if (normalized) persist()
}

function canAccess(entry: ProcEntry, ctx: MethodCtx): boolean {
  return entry.workspaceId === ctx.identity.workspaceId || connHasCap(ctx.authed, 'all-workspaces')
}

function resolveAuthorized(idOrName: string, ctx: MethodCtx): ProcEntry | undefined {
  const byId = procs.get(idOrName)
  if (byId) return canAccess(byId, ctx) ? byId : undefined
  const candidates = [...procs.values()].filter((p) => p.name === idOrName)
  const own = candidates.find((p) => p.workspaceId === ctx.identity.workspaceId)
  if (own) return own
  return connHasCap(ctx.authed, 'all-workspaces') ? candidates[0] : undefined
}

function toInfoShape(entry: ProcEntry) {
  const { id, name, cmd, cwd, status, pid, exitCode, startedAt } = entry
  return { id, name, cmd, cwd, status, pid, exitCode, startedAt }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {}
  }
  try {
    child.kill(signal)
  } catch {}
}

export interface ProcessSandbox {
  isEnabled: (workspaceId: string) => boolean
  wrap: (workspaceId: string, command: string) => Promise<string>
  tmpDir: (workspaceId: string) => string
}

export interface ProcessDeps {
  sandbox?: ProcessSandbox
}

let sandbox: ProcessSandbox | undefined

async function spawnChild(
  cmd: string,
  cwd: string,
  workspaceId: string,
  env?: Record<string, string>,
): Promise<ChildProcess> {
  const merged = { ...process.env, ...env }
  if (!sandbox?.isEnabled(workspaceId)) {
    return spawn(cmd, { shell: true, detached: true, cwd, env: merged })
  }
  const wrapped = await sandbox.wrap(workspaceId, cmd)
  return spawn('/bin/sh', ['-c', wrapped], {
    detached: true,
    cwd,
    env: {
      ...sandboxSpawnEnv(merged as Record<string, string>),
      TMPDIR: sandbox.tmpDir(workspaceId),
    },
  })
}

function sandboxRefusal(err: unknown) {
  return {
    ok: false as const,
    error: 'sandbox-unavailable' as const,
    message: err instanceof Error ? err.message : String(err),
  }
}

async function spawnEntry(
  id: string,
  name: string,
  cmd: string,
  cwd: string,
  workspaceId: string,
  env?: Record<string, string>,
): Promise<ProcEntry> {
  const child = await spawnChild(cmd, cwd, workspaceId, env)
  const entry: ProcEntry = {
    id,
    name,
    cmd,
    cwd,
    workspaceId,
    status: 'running',
    pid: child.pid,
    startedAt: new Date().toISOString(),
    output: new PtyRingBuffer(),
    child,
    env,
  }
  child.stdout?.on('data', (d: Buffer) => entry.output.push(d.toString()))
  child.stderr?.on('data', (d: Buffer) => entry.output.push(d.toString()))
  child.on('error', (err) => {
    entry.output.push(`${err.message}\n`)
    if (entry.status === 'running') entry.status = 'exited'
    entry.exitCode = entry.exitCode ?? -1
    persist()
  })
  child.on('exit', (code) => {
    if (entry.status !== 'killed') entry.status = 'exited'
    entry.exitCode = code ?? -1
    persist()
  })
  return entry
}

export function registerProcessMethods(deps: ProcessDeps = {}): void {
  sandbox = deps.sandbox
  loadPersisted()

  registerTargetableMethod('process.run', {
    cap: 'process',
    handler: async (params, ctx) => {
      const { cmd, name, cwd, env } = (params ?? {}) as {
        cmd: string
        name?: string
        cwd?: string
        env?: Record<string, string>
      }
      const id = `proc-${++counter}`
      const resolvedCwd = cwd ?? workDirForWorkspace(ctx.identity.workspaceId) ?? process.cwd()
      let entry: ProcEntry
      try {
        entry = await spawnEntry(id, name ?? id, cmd, resolvedCwd, ctx.identity.workspaceId, env)
      } catch (err) {
        return sandboxRefusal(err)
      }
      procs.set(id, entry)
      persist()
      return { id: entry.id, name: entry.name, pid: entry.pid }
    },
  })

  registerTargetableMethod('process.list', {
    cap: 'process',
    handler: (_params, ctx) => {
      const all = [...procs.values()]
      const visible = connHasCap(ctx.authed, 'all-workspaces')
        ? all
        : all.filter((p) => p.workspaceId === ctx.identity.workspaceId)
      return visible.map(toInfoShape)
    },
  })

  registerTargetableMethod('process.info', {
    cap: 'process',
    handler: (params, ctx) => {
      const { id } = (params ?? {}) as { id: string }
      const entry = resolveAuthorized(id, ctx)
      return entry ? toInfoShape(entry) : NOT_FOUND
    },
  })

  registerTargetableMethod('process.output', {
    cap: 'process',
    handler: (params, ctx) => {
      const { id, sinceCursor } = (params ?? {}) as { id: string; sinceCursor?: number }
      const entry = resolveAuthorized(id, ctx)
      if (!entry) return NOT_FOUND
      return entry.output.since(sinceCursor ?? 0)
    },
  })

  registerTargetableMethod('process.kill', {
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

  registerTargetableMethod('process.restart', {
    cap: 'process',
    handler: async (params, ctx) => {
      const { id } = (params ?? {}) as { id: string }
      const entry = resolveAuthorized(id, ctx)
      if (!entry) return NOT_FOUND
      if (!entry.child) return { ok: false, error: 'not-restartable' as const }
      if (entry.status === 'running') killTree(entry.child, 'SIGTERM')
      let fresh: ProcEntry
      try {
        fresh = await spawnEntry(
          entry.id,
          entry.name,
          entry.cmd,
          entry.cwd,
          entry.workspaceId,
          entry.env,
        )
      } catch (err) {
        entry.status = 'exited'
        persist()
        return sandboxRefusal(err)
      }
      procs.set(entry.id, fresh)
      persist()
      return { id: fresh.id }
    },
  })
}

export function killAllProcesses(): void {
  for (const entry of procs.values()) {
    if (entry.status === 'running' && entry.child) {
      killTree(entry.child, 'SIGTERM')
    }
  }
}
