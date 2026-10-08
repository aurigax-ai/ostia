import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { isIP } from 'node:net'
import { posix, win32 } from 'node:path'
import { createInterface } from 'node:readline'
import { PRODUCT_NAME } from '../../shared/product'
import type { GatewayTailnetState } from '../../shared/types'

const STOP_GRACE_MS = 3000
const LOGOUT_TIMEOUT_MS = 15_000
const MAX_AUTH_URL_LENGTH = 2048
const DNS_NAME = /^[a-z0-9.-]{1,253}$/i
const ERROR_CODE = /^[a-z-]{1,40}$/
const DEFAULT_LOGIN_HOST = 'login.tailscale.com'

export function tsnetHelperPath(appPath: string, platform: NodeJS.Platform): string {
  const path = platform === 'win32' ? win32 : posix
  const binary = platform === 'win32' ? 'ostia-tsnet.exe' : 'ostia-tsnet'
  return path.join(appPath.replace(/\.asar$/, '.asar.unpacked'), 'out', 'tsnet', binary)
}

export type TailnetState = GatewayTailnetState

export interface TailnetOptions {
  command: string
  args?: string[]
  stateDir: string
  hostname: string
  env?: NodeJS.ProcessEnv
  onChange?: (state: TailnetState) => void
  log?: (event: string, fields?: Record<string, string | number>) => void
}

export interface Tailnet {
  start(target: { helperPort: number; port: number }): void
  stop(): Promise<void>
  signOut(): Promise<void>
  state(): TailnetState
}

export function tailnetNodeName(hostname: string): string {
  const slug = hostname
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug ? `${PRODUCT_NAME}-${slug}` : PRODUCT_NAME
}

export function isAllowedLoginUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' && parsed.host === DEFAULT_LOGIN_HOST
}

function parseHelperLine(line: string): TailnetState | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const ev = raw as Record<string, unknown>
  switch (ev.state) {
    case 'starting':
      return { state: 'starting' }
    case 'needs-login':
      return typeof ev.authUrl === 'string' && ev.authUrl.length <= MAX_AUTH_URL_LENGTH
        ? { state: 'needs-login', authUrl: ev.authUrl }
        : null
    case 'running':
      return {
        state: 'running',
        ip: typeof ev.ip === 'string' && isIP(ev.ip) === 4 ? ev.ip : null,
        dnsName: typeof ev.dnsName === 'string' && DNS_NAME.test(ev.dnsName) ? ev.dnsName : null,
      }
    case 'error':
      return typeof ev.code === 'string' && ERROR_CODE.test(ev.code)
        ? { state: 'error', code: ev.code }
        : null
    default:
      return null
  }
}

function ensurePrivateDir(dir: string): boolean {
  try {
    const stat = lstatSync(dir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  chmodSync(dir, 0o700)
  return true
}

function waitForExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export function createTailnet(options: TailnetOptions): Tailnet {
  let current: TailnetState = { state: 'off' }
  let child: ChildProcessWithoutNullStreams | null = null

  const setState = (next: TailnetState): void => {
    current = next
    options.onChange?.(next)
  }

  const spawnHelper = (args: string[]): ChildProcessWithoutNullStreams =>
    spawn(options.command, [...(options.args ?? []), ...args], {
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

  const baseArgs = (): string[] => ['--dir', options.stateDir, '--hostname', options.hostname]

  const start: Tailnet['start'] = (target) => {
    if (child) return
    if (!ensurePrivateDir(options.stateDir)) {
      setState({ state: 'error', code: 'state-dir-unsafe' })
      return
    }
    setState({ state: 'starting' })
    const proc = spawnHelper([
      ...baseArgs(),
      '--port',
      String(target.port),
      '--target',
      `127.0.0.1:${target.helperPort}`,
    ])
    child = proc
    proc.stderr.resume()
    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (child !== proc) return
      const next = parseHelperLine(line)
      if (!next) {
        options.log?.('tailnet.helper-line-ignored', { length: line.length })
        return
      }
      setState(next)
    })
    proc.once('error', () => {
      if (child !== proc) return
      child = null
      setState({ state: 'error', code: 'helper-unavailable' })
    })
    proc.once('exit', () => {
      if (child !== proc) return
      child = null
      setState({ state: 'error', code: 'helper-stopped' })
    })
  }

  const stop: Tailnet['stop'] = async () => {
    const proc = child
    child = null
    if (proc) {
      proc.stdin.end()
      await waitForExit(proc, STOP_GRACE_MS)
    }
    if (current.state !== 'off') setState({ state: 'off' })
  }

  const signOut: Tailnet['signOut'] = async () => {
    await stop()
    const proc = spawnHelper([...baseArgs(), '--logout'])
    proc.stdout.resume()
    proc.stderr.resume()
    proc.stdin.end()
    await new Promise<void>((resolve) => {
      proc.once('error', () => resolve())
      void waitForExit(proc, LOGOUT_TIMEOUT_MS).then(resolve)
    })
    rmSync(options.stateDir, { recursive: true, force: true })
  }

  return { start, stop, signOut, state: () => current }
}
