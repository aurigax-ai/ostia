import { type ChildProcess, spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { delimiter, join } from 'node:path'
import { runTool } from '@aurigax-ai/ostia-extension-sdk'

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
  | 'unsupported'
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
  backend?: string
}

const EXIT_CODES: Record<number, ScreensErrorCode> = {
  2: 'usage',
  3: 'not-found',
  4: 'refused',
  5: 'backend',
  6: 'unsupported',
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

export async function runScreens<T>(run: ScreensRun): Promise<ScreensResult<T>> {
  const result = await runTool(SCREENS_BIN, [...run.args, '--json'], {
    env: toolEnv(run.token),
    timeoutMs: run.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutput: MAX_OUTPUT,
  })
  if (result.missing) return { ok: false, code: 'not-installed', message: 'screens is not on PATH' }
  if (result.timedOut) {
    return { ok: false, code: 'timeout', message: 'screens did not answer in time' }
  }
  if (result.code !== 0) return { ok: false, ...errorOf(result.stdout, result.stderr, result.code) }
  try {
    return { ok: true, value: JSON.parse(result.stdout) as T }
  } catch {
    return { ok: false, code: 'backend', message: 'screens printed no JSON' }
  }
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
export const PHONE_SERVICE_VERSION = '0.1.4'
const VERSION = /^(\d+)\.(\d+)\.(\d+)/

function versionParts(version: string): number[] | null {
  const match = VERSION.exec(version.trim())
  return match ? match.slice(1, 4).map(Number) : null
}

export function isOutdated(version: string, minimum = MIN_SERVICE_VERSION): boolean {
  const have = versionParts(version)
  const need = versionParts(minimum) ?? []
  if (!have) return true
  for (let i = 0; i < need.length; i++) {
    if (have[i] !== need[i]) return have[i] < need[i]
  }
  return false
}

export async function serviceVersion(): Promise<string | null> {
  const result = await runTool(SCREENS_BIN, ['--version'], {
    env: toolEnv(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  })
  return result.code === 0 && versionParts(result.stdout) ? result.stdout.trim() : null
}

export function spawnViewer(id: string, viewerToken: string): ChildProcess {
  return spawn(SCREENS_BIN, ['view', id], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: toolEnv(viewerToken),
  })
}

type LeaseRequest =
  | { width?: number; height?: number; allow: string[]; label: string }
  | { backend: 'phone'; width: number; height: number; label: string }

interface LeasedScreen {
  screen: CreatedScreen
  lease: Socket
}

const REPLY_CODES = new Set<ScreensErrorCode>([
  'usage',
  'not-found',
  'refused',
  'backend',
  'unsupported',
])

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

export async function createLeased(
  req: LeaseRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ScreensResult<LeasedScreen>> {
  const started = await runScreens<unknown>({ args: ['list'], timeoutMs })
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
    ...('backend' in req ? { backend: req.backend } : { allow: req.allow }),
    label: req.label,
    lease: true,
  }
  socket.write(`${JSON.stringify(request)}\n`)
  const line = await firstLine(socket, timeoutMs)
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
