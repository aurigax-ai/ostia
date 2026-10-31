import { type ChildProcess, spawn } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { envName, isAppEnvName } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import {
  EXEC_ENV_MAX,
  EXEC_ENV_VALUE_MAX,
  EXEC_OUTPUT_DEFAULT,
  EXEC_OUTPUT_MAX,
  EXEC_TIMEOUT_MAX_MS,
  TERMINAL_ARG_MAX,
  TERMINAL_COMMAND_MAX_ARGS,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { quoteArgv } from '../../shared/terminal/shellQuote'
import { withoutGpuLaunchEnv } from '../platform/discreteGpu'
import { withoutInheritedFiles } from '../platform/inheritableFiles'
import { SandboxUnavailableError } from '../sandbox/hostClient'

export const EXEC_CONCURRENT_MAX = 8
const EXEC_KILL_GRACE_MS = 5000
const EXEC_DIR_ENV = envName('EXEC_DIR')
const ENV_NAME = /^GRAPH_[A-Z0-9_]{1,58}$/

function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export interface ExecWorkspace {
  workDir: string
  scratch?: boolean
  sandboxed?: boolean
}

export interface ExecDeps {
  workspace: (workspaceId: string) => ExecWorkspace | null
  wrap: (workspaceId: string, command: string, extraReads: string[]) => Promise<string>
  sandboxEnv: (workspaceId: string, env: Record<string, string>) => Record<string, string>
  dataDir: (extId: string) => string
  baseEnv: () => NodeJS.ProcessEnv
}

export type ExecReply =
  | {
      ok: true
      exitCode: number
      signal?: string
      timedOut: boolean
      stdout: string
      stderr: string
      truncated: boolean
      sandboxed: boolean
    }
  | { ok: false; error: string; message?: string }

interface Request {
  workspaceId: string
  command: string[]
  timeoutMs: number
  maxOutputBytes: number
  env: Record<string, string>
  dataDir?: string
}

function refuse(error: string, message?: string): ExecReply {
  return message ? { ok: false, error, message } : { ok: false, error }
}

function parseEnv(raw: unknown): Record<string, string> | string {
  if (raw === undefined) return {}
  if (!isRecord(raw)) return 'env is an object of names to values'
  const entries = Object.entries(raw)
  if (entries.length > EXEC_ENV_MAX) return `env has at most ${EXEC_ENV_MAX} names`
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name))
      return `env name ${name} is not allowed; names are GRAPH_ and capitals`
    if (typeof value !== 'string' || value.length > EXEC_ENV_VALUE_MAX || hasControl(value)) {
      return `env ${name} must be a string of at most ${EXEC_ENV_VALUE_MAX} characters without control characters`
    }
  }
  return Object.fromEntries(entries) as Record<string, string>
}

function parseRequest(raw: unknown): Request | string {
  const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (typeof p.workspaceId !== 'string' || !p.workspaceId) return 'workspaceId is required'
  const command = p.command
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.length > TERMINAL_COMMAND_MAX_ARGS ||
    !command.every(
      (a) => typeof a === 'string' && a.length <= TERMINAL_ARG_MAX && !hasControl(a),
    ) ||
    command[0] === ''
  ) {
    return `command is 1-${TERMINAL_COMMAND_MAX_ARGS} strings without control characters`
  }
  const timeoutMs = p.timeoutMs
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > EXEC_TIMEOUT_MAX_MS
  ) {
    return `timeoutMs is 1-${EXEC_TIMEOUT_MAX_MS}`
  }
  const maxOutputBytes = p.maxOutputBytes ?? EXEC_OUTPUT_DEFAULT
  if (
    typeof maxOutputBytes !== 'number' ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > EXEC_OUTPUT_MAX
  ) {
    return `maxOutputBytes is 1-${EXEC_OUTPUT_MAX}`
  }
  const env = parseEnv(p.env)
  if (typeof env === 'string') return env
  if (p.dataDir !== undefined && (typeof p.dataDir !== 'string' || !p.dataDir))
    return 'dataDir is a relative path'
  return {
    workspaceId: p.workspaceId,
    command: command as string[],
    timeoutMs,
    maxOutputBytes,
    env,
    ...(typeof p.dataDir === 'string' ? { dataDir: p.dataDir } : {}),
  }
}

function resolveDataDir(root: string, rel: string): string | null {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return null
  const path = join(root, rel)
  try {
    let at = root
    for (const part of relative(root, path).split(sep).filter(Boolean)) {
      at = join(at, part)
      if (lstatSync(at).isSymbolicLink()) return null
    }
    if (!lstatSync(path).isDirectory()) return null
    return realpathSync(path)
  } catch {
    return null
  }
}

function cleanEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !isAppEnvName(name)) out[name] = value
  }
  return out
}

interface Running {
  child: ChildProcess
  kill: () => void
  killNow: () => void
}

export class ExtensionExec {
  private readonly running = new Map<string, Set<Running>>()

  constructor(private readonly deps: ExecDeps) {}

  active(extId: string): number {
    return this.running.get(extId)?.size ?? 0
  }

  stopFor(extId: string): void {
    for (const run of this.running.get(extId) ?? []) run.kill()
  }

  stopAll(): void {
    for (const extId of this.running.keys()) this.stopFor(extId)
  }

  killAll(): void {
    for (const set of this.running.values()) for (const run of set) run.killNow()
  }

  async run(extId: string, raw: unknown, signal?: AbortSignal): Promise<ExecReply> {
    const req = parseRequest(raw)
    if (typeof req === 'string') return refuse('invalid-params', req)
    let execDir: string | undefined
    if (req.dataDir !== undefined) {
      const resolved = resolveDataDir(this.deps.dataDir(extId), req.dataDir)
      if (!resolved)
        return refuse(
          'invalid-params',
          'dataDir is an existing folder inside your data folder, not a link',
        )
      execDir = resolved
    }
    const workspace = this.deps.workspace(req.workspaceId)
    if (!workspace) return refuse('unknown-workspace')
    if (workspace.scratch)
      return refuse('scratch', 'nothing runs without a terminal in a scratch workspace')
    if (this.active(extId) >= EXEC_CONCURRENT_MAX) {
      return refuse('too-many', `at most ${EXEC_CONCURRENT_MAX} commands at once`)
    }
    let env: Record<string, string> = {
      ...cleanEnv(withoutGpuLaunchEnv(this.deps.baseEnv())),
      ...req.env,
    }
    if (execDir) env[EXEC_DIR_ENV] = execDir
    let file = req.command[0]
    let args = req.command.slice(1)
    if (workspace.sandboxed) {
      try {
        const wrapped = await this.deps.wrap(
          req.workspaceId,
          quoteArgv(req.command),
          execDir ? [execDir] : [],
        )
        file = '/bin/sh'
        args = ['-c', wrapped]
        env = this.deps.sandboxEnv(req.workspaceId, env)
      } catch (err) {
        if (err instanceof SandboxUnavailableError)
          return refuse('sandbox-unavailable', err.message)
        throw err
      }
    }
    return this.spawnChild(extId, file, args, env, workspace, req, signal)
  }

  private spawnChild(
    extId: string,
    file: string,
    args: string[],
    env: Record<string, string>,
    workspace: ExecWorkspace,
    req: Request,
    signal?: AbortSignal,
  ): Promise<ExecReply> {
    return new Promise((resolveReply) => {
      let child: ChildProcess
      const { stdio, release } = withoutInheritedFiles(['ignore', 'pipe', 'pipe'])
      try {
        child = spawn(file, args, {
          cwd: workspace.workDir,
          env,
          shell: false,
          detached: true,
          stdio,
        })
      } catch (err) {
        resolveReply(refuse('spawn-failed', err instanceof Error ? err.message : String(err)))
        return
      } finally {
        release()
      }
      const out: Buffer[] = []
      const errOut: Buffer[] = []
      let outBytes = 0
      let errBytes = 0
      let truncated = false
      let timedOut = false
      let killTimer: ReturnType<typeof setTimeout> | null = null
      const group = (sig: NodeJS.Signals): void => {
        try {
          if (child.pid) process.kill(-child.pid, sig)
        } catch {}
      }
      const kill = (): void => {
        if (killTimer) return
        group('SIGTERM')
        killTimer = setTimeout(() => group('SIGKILL'), EXEC_KILL_GRACE_MS)
      }
      const entry: Running = { child, kill, killNow: () => group('SIGKILL') }
      const set = this.running.get(extId) ?? new Set<Running>()
      set.add(entry)
      this.running.set(extId, set)
      const collect = (chunks: Buffer[], add: number, chunk: Buffer): number => {
        const room = req.maxOutputBytes - add
        if (room <= 0) {
          truncated = true
          return add
        }
        if (chunk.length > room) truncated = true
        chunks.push(chunk.subarray(0, room))
        return add + Math.min(room, chunk.length)
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        outBytes = collect(out, outBytes, chunk)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        errBytes = collect(errOut, errBytes, chunk)
      })
      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, req.timeoutMs)
      const onAbort = (): void => kill()
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) kill()
      let settled = false
      const finish = (reply: ExecReply): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        set.delete(entry)
        group('SIGKILL')
        if (killTimer) clearTimeout(killTimer)
        resolveReply(reply)
      }
      child.on('error', (err) => finish(refuse('spawn-failed', err.message)))
      child.on('exit', () => group('SIGKILL'))
      child.on('close', (code, sig) => {
        finish({
          ok: true,
          exitCode: timedOut || code === null ? -1 : code,
          ...(sig ? { signal: sig } : {}),
          timedOut,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(errOut).toString('utf8'),
          truncated,
          sandboxed: workspace.sandboxed === true,
        })
      })
    })
  }
}
