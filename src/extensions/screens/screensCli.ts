import { type ChildProcess, spawn } from 'node:child_process'
import { constants, accessSync, statSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { type Socket, connect } from 'node:net'
import { delimiter, join } from 'node:path'

export const SCREENS_BIN = 'screens'
const TOKEN_ENV = 'SCREENS_TOKEN'
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT = 32 * 1024 * 1024
const DAEMON_SOCKET = ['screens', 'daemon.sock']

type ScreensErrorCode =
  | 'outdated'
  | 'usage'
  | 'not-found'
  | 'refused'
  | 'backend'
  | 'not-installed'
  | 'timeout'

export type ScreensResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ScreensErrorCode; message: string }

export interface ScreensRun {
  args: string[]
  token?: string
  timeoutMs?: number
}

export interface CreatedScreen {
  id: string
  agentToken: string
  viewerToken: string
  width: number
  height: number
}

export interface ListedScreen {
  id: string
  width: number
  height: number
  label: string
  owner: string
  state: string
}

const EXIT_CODES: Record<number, ScreensErrorCode> = {
  2: 'usage',
  3: 'not-found',
  4: 'refused',
  5: 'backend',
}

function toolEnv(token?: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env[TOKEN_ENV]
  if (token) env[TOKEN_ENV] = token
  return env
}

function errorOf(
  stdout: string,
  stderr: string,
  exit: number | null,
): { code: ScreensErrorCode; message: string } {
  const code = EXIT_CODES[exit ?? 5] ?? 'backend'
  try {
    const parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '') as {
      error?: { message?: unknown }
    }
    if (typeof parsed.error?.message === 'string') return { code, message: parsed.error.message }
  } catch {}
  const line = stderr.trim().split('\n').pop() ?? ''
  return { code, message: line.replace(/^screens: /, '') || `screens exited with ${exit}` }
}

export function isOnPath(name: string, path = process.env.PATH ?? ''): boolean {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      accessSync(file, constants.X_OK)
      return true
    } catch {}
  }
  return false
}

export function runScreens<T>(run: ScreensRun): Promise<ScreensResult<T>> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: ScreensResult<T>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const child = spawn(SCREENS_BIN, [...run.args, '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: toolEnv(run.token),
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, code: 'timeout', message: 'screens did not answer in time' })
    }, run.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8')
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(
        err.code === 'ENOENT'
          ? { ok: false, code: 'not-installed', message: 'screens is not on PATH' }
          : { ok: false, code: 'backend', message: err.message },
      )
    })
    child.on('close', (exit) => {
      if (exit !== 0) return finish({ ok: false, ...errorOf(stdout, stderr, exit) })
      try {
        finish({ ok: true, value: JSON.parse(stdout) as T })
      } catch {
        finish({ ok: false, code: 'backend', message: 'screens printed no JSON' })
      }
    })
  })
}

export interface EventStream {
  stop: () => void
}

export function watchEvents(
  id: string,
  token: string,
  onEvent: (event: Record<string, unknown>) => void,
): EventStream {
  const child: ChildProcess = spawn(SCREENS_BIN, ['events', id, '--json'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: toolEnv(token),
  })
  let pending = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as unknown
        if (typeof event === 'object' && event !== null && !Array.isArray(event)) {
          onEvent(event as Record<string, unknown>)
        }
      } catch {}
    }
  })
  child.on('error', () => {})
  return { stop: () => child.kill('SIGTERM') }
}

export const MIN_SERVICE_VERSION = '0.1.1'
const VERSION = /^(\d+)\.(\d+)\.(\d+)/

function versionParts(version: string): number[] | null {
  const match = VERSION.exec(version.trim())
  return match ? match.slice(1, 4).map(Number) : null
}

export function isOutdated(version: string): boolean {
  const have = versionParts(version)
  const need = versionParts(MIN_SERVICE_VERSION) ?? []
  if (!have) return true
  for (let i = 0; i < need.length; i++) {
    if (have[i] !== need[i]) return have[i] < need[i]
  }
  return false
}

export function serviceVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(SCREENS_BIN, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: toolEnv(),
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), DEFAULT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 && versionParts(out) ? out.trim() : null)
    })
  })
}

export function spawnViewer(id: string, viewerToken: string): ChildProcess {
  return spawn(SCREENS_BIN, ['view', id], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: toolEnv(viewerToken),
  })
}

interface LeaseRequest {
  width?: number
  height?: number
  allow: string[]
  label: string
}

interface LeasedScreen {
  screen: CreatedScreen
  lease: Socket
}

const REPLY_CODES = new Set<ScreensErrorCode>(['usage', 'not-found', 'refused', 'backend'])

function daemonSocketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`
  return join(runtime, ...DAEMON_SOCKET)
}

function openDaemon(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

function firstLine(socket: Socket, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let text = ''
    const done = (line: string | null): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
      resolve(line)
    }
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('utf8')
      const end = text.indexOf('\n')
      if (end !== -1) done(text.slice(0, end))
    }
    const onClose = (): void => done(null)
    const timer = setTimeout(() => done(null), timeoutMs)
    socket.on('data', onData)
    socket.on('close', onClose)
  })
}

function failed(code: ScreensErrorCode, message: string): ScreensResult<never> {
  return { ok: false, code, message }
}

export async function createLeased(req: LeaseRequest): Promise<ScreensResult<LeasedScreen>> {
  const started = await runScreens<unknown>({ args: ['list'] })
  if (!started.ok) return started
  const path = daemonSocketPath()
  try {
    if (!(await lstat(path)).isSocket()) return failed('backend', `${path} is not a socket`)
  } catch {
    return failed('backend', 'the screens daemon is not running')
  }
  let socket: Socket
  try {
    socket = await openDaemon(path)
  } catch (err) {
    return failed('backend', err instanceof Error ? err.message : String(err))
  }
  socket.on('error', () => socket.destroy())
  const request = {
    verb: 'create',
    ...(req.width === undefined ? {} : { width: req.width }),
    ...(req.height === undefined ? {} : { height: req.height }),
    allow: req.allow,
    label: req.label,
    lease: true,
  }
  socket.write(`${JSON.stringify(request)}\n`)
  const line = await firstLine(socket, DEFAULT_TIMEOUT_MS)
  let reply: Record<string, unknown> = {}
  try {
    reply = line === null ? {} : (JSON.parse(line) as Record<string, unknown>)
  } catch {}
  const { id, agentToken, viewerToken, width, height } = reply
  if (
    reply.ok !== true ||
    typeof id !== 'string' ||
    typeof agentToken !== 'string' ||
    typeof viewerToken !== 'string' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    socket.destroy()
    const code = REPLY_CODES.has(reply.code as ScreensErrorCode)
      ? (reply.code as ScreensErrorCode)
      : 'backend'
    const message =
      typeof reply.message === 'string' ? reply.message : 'the daemon did not create a screen'
    return failed(code, message)
  }
  return {
    ok: true,
    value: { screen: { id, agentToken, viewerToken, width, height }, lease: socket },
  }
}
