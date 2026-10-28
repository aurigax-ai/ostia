import { spawn } from 'node:child_process'
import { closeSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { KeptLink } from '../../shared/terminal/ptyApi'
import { processAlive } from '../platform/processAlive'
import { ControlClient, type ControlEnd, withoutInheritedFds } from './controlClient'
import type { ControlEvent } from './controlMode'
import {
  decodeMeta,
  encodeMeta,
  META_OPTION,
  type NewWindowSpec,
  newWindowCommand,
  tmuxQuote,
} from './tmuxCommand'
import { tmuxConf } from './tmuxConf'
import { LOST_EXIT_CODE, TmuxPane } from './tmuxPane'

const TMUX_SESSION = 'ostia'
const HOLDER_META = 'holder'
const DEAD_SUBSCRIPTION = 'ostia-dead'
const DEAD_FORMAT = '#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}'
const EXIT_POLL_MS = 50
const EXIT_POLL_TRIES = 40
const COMMAND_SUBSCRIPTION = 'ostia-cmd'
const SERVER_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR']
const FIELD_SEPARATOR = '\t'
const PENDING_OUTPUT_CAP = 256
const RECONNECT_MS = 10_000
const RECONNECT_PAUSE_MS = 250

export class TmuxSocketDirError extends Error {}

export function ensureTmuxSocketDir(dir: string, uid: number): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o777) !== 0o700) {
    throw new TmuxSocketDirError(`refusing to use ${dir}: not a 0700 directory owned by uid ${uid}`)
  }
  return dir
}

export function serverEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of SERVER_ENV_KEYS) if (parent[key] !== undefined) env[key] = parent[key]
  return env
}

export interface TmuxServerOptions {
  tmux: string
  dir: string
  name: string
  defaultTerminal: string
  env: NodeJS.ProcessEnv
  log?: TmuxLog
}

export type TmuxLog = (event: string, fields: Record<string, string>) => void

export interface KeptWindow {
  windowId: string
  paneId: string
  pid: number
  dead: boolean
  cols: number
  rows: number
  meta: unknown
}

interface Waiter {
  resolve: (lines: string[]) => void
  reject: (err: Error) => void
  onReply?: () => void
}

const RUN_TIMEOUT_MS = 5000
const SERVER_EXIT_WAIT_MS = 3000
const SERVER_EXIT_POLL_MS = 20

async function processGone(pid: number, ms: number): Promise<void> {
  if (pid <= 0) return
  const end = Date.now() + ms
  while (processAlive(pid) && Date.now() < end) {
    await sleep(SERVER_EXIT_POLL_MS)
  }
}
const RUN_DRAIN_MS = 200
const RUN_STDERR_CAP = 2000

interface RunResult {
  ok: boolean
  stderr: string
}

function run(tmux: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  const devNull = openSync('/dev/null', 'r+')
  const stdio = withoutInheritedFds(['ignore', 'ignore', 'pipe'], devNull)
  return new Promise<RunResult>((resolve) => {
    const child = spawn(tmux, args, { env, stdio })
    let stderr = ''
    let code: number | null = null
    let drain: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, RUN_TIMEOUT_MS)
    const finish = (ok: boolean): void => {
      clearTimeout(timer)
      clearTimeout(drain)
      resolve({ ok, stderr: stderr.trim().slice(0, RUN_STDERR_CAP) })
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      stderr += err.message
      finish(false)
    })
    child.on('exit', (exitCode) => {
      code = exitCode
      drain = setTimeout(() => finish(code === 0), RUN_DRAIN_MS)
    })
    child.on('close', () => finish(code === 0))
  }).finally(() => closeSync(devNull))
}

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('tmux did not answer')), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

export function parseExit(value: string): number | null {
  const [dead, status, signal] = value.split(':')
  if (dead !== '1') return null
  if (status) return Number(status)
  return signal ? 128 + Number(signal) : null
}

export class TmuxServer {
  private readonly waiters: Waiter[] = []
  private readonly panes = new Map<string, TmuxPane>()
  private readonly pendingOutput = new Map<string, string[]>()
  private client: ControlClient | null = null
  private closed = false
  private suspended = false
  private leaving = false
  private reconnecting = false
  private attached = false
  private link: KeptLink = 'up'
  private serverPid = 0
  started = false

  private constructor(
    private readonly socket: string,
    private readonly launch: { tmux: string; args: string[]; env: NodeJS.ProcessEnv },
    private readonly onGone: () => void,
    private readonly log: TmuxLog,
  ) {}

  static async connect(options: TmuxServerOptions, onGone: () => void): Promise<TmuxServer> {
    const uid = process.getuid?.() ?? 0
    const dir = ensureTmuxSocketDir(options.dir, uid)
    const socket = join(dir, options.name)
    const conf = join(dir, `${options.name}.conf`)
    writeFileSync(conf, tmuxConf(options.defaultTerminal), { mode: 0o600 })
    const base = ['-u', '-S', socket, '-f', conf]
    const env = serverEnv(options.env)
    let fresh = false
    if (!(await run(options.tmux, [...base, 'has-session', '-t', TMUX_SESSION], env)).ok) {
      const started = await run(
        options.tmux,
        [
          ...base,
          'new-session',
          '-d',
          '-s',
          TMUX_SESSION,
          '-n',
          HOLDER_META,
          '--',
          'tail',
          '-f',
          '/dev/null',
        ],
        env,
      )
      if (!started.ok) {
        const reason = started.stderr ? `: ${started.stderr}` : ''
        throw new Error(`tmux could not start its server${reason}`)
      }
      fresh = true
    }
    const launch = {
      tmux: options.tmux,
      args: [...base, '-C', 'attach-session', '-t', TMUX_SESSION],
      env,
    }
    const server = new TmuxServer(socket, launch, onGone, options.log ?? (() => undefined))
    server.started = fresh
    await server.attach()
    server.attached = true
    return server
  }

  get socketPath(): string {
    return this.socket
  }

  get alive(): boolean {
    return !this.closed
  }

  command(line: string): Promise<string[]> {
    return this.batch([line]).then((replies) => replies[0] ?? [])
  }

  batch(lines: string[], onLastReply?: () => void): Promise<string[][]> {
    const client = this.client
    if (this.closed) return Promise.reject(new Error('tmux is gone'))
    if (!client) return Promise.reject(new Error('tmux is reconnecting'))
    const replies = lines.map(
      (_line, i) =>
        new Promise<string[]>((resolve, reject) => {
          const last = i === lines.length - 1
          this.waiters.push({
            resolve,
            reject,
            ...(last && onLastReply ? { onReply: onLastReply } : {}),
          })
        }),
    )
    client.write(lines.join(' ; '))
    return Promise.all(replies)
  }

  send(line: string): void {
    void this.command(line).catch(() => undefined)
  }

  async spawn(
    spec: Omit<NewWindowSpec, 'session'> & { cols: number; rows: number; meta: unknown },
  ): Promise<TmuxPane> {
    const [, [line]] = await this.batch([
      `set -t ${tmuxQuote(TMUX_SESSION)} default-size ${spec.cols}x${spec.rows}`,
      newWindowCommand({ ...spec, session: TMUX_SESSION }),
    ])
    const [windowId, paneId, pid] = (line ?? '').split(' ')
    if (!windowId || !paneId) throw new Error('tmux did not open a window')
    this.send(`set -w -t ${windowId} ${META_OPTION} ${tmuxQuote(encodeMeta(spec.meta))}`)
    return this.track(windowId, paneId, Number(pid), spec.cols, spec.rows, true)
  }

  async windows(): Promise<KeptWindow[]> {
    const format = [
      '#{window_id}',
      '#{pane_id}',
      '#{pane_pid}',
      '#{pane_dead}',
      '#{window_width}',
      '#{window_height}',
      `#{${META_OPTION}}`,
    ].join(FIELD_SEPARATOR)
    const lines = await this.command(
      `list-windows -t ${tmuxQuote(TMUX_SESSION)} -F ${tmuxQuote(format)}`,
    )
    const kept: KeptWindow[] = []
    for (const line of lines) {
      const [windowId, paneId, pid, dead, cols, rows, meta] = line.split(FIELD_SEPARATOR)
      if (meta === undefined || windowId === undefined || paneId === undefined) continue
      const decoded = decodeMeta(meta)
      if (decoded === null) continue
      kept.push({
        windowId,
        paneId,
        pid: Number(pid),
        dead: dead === '1',
        cols: Number(cols),
        rows: Number(rows),
        meta: decoded,
      })
    }
    return kept
  }

  adopt(window: KeptWindow): TmuxPane {
    return this.track(window.windowId, window.paneId, window.pid, window.cols, window.rows, false)
  }

  killWindow(windowId: string): Promise<void> {
    return this.command(`kill-window -t ${windowId}`).then(
      () => undefined,
      () => undefined,
    )
  }

  async killServer(): Promise<void> {
    this.leaving = true
    await this.command('kill-server').catch(() => undefined)
    this.close()
    await processGone(this.serverPid, SERVER_EXIT_WAIT_MS)
  }

  close(): void {
    if (this.closed) return
    this.leaving = true
    this.client?.detach()
    this.gone()
  }

  suspend(): void {
    if (this.closed || this.suspended) return
    this.suspended = true
    this.client?.detach()
  }

  resume(): void {
    if (this.closed || !this.suspended) return
    this.suspended = false
    void this.reconnect()
  }

  retry(): void {
    if (this.link === 'failed') void this.reconnect()
  }

  forget(pane: TmuxPane): void {
    this.panes.delete(pane.paneId)
    this.client?.forgetPane(pane.paneId)
  }

  private track(
    windowId: string,
    paneId: string,
    pid: number,
    cols: number,
    rows: number,
    keepEarlyOutput: boolean,
  ): TmuxPane {
    const pane = new TmuxPane(this, windowId, paneId, pid, cols, rows)
    this.panes.set(paneId, pane)
    if (this.link !== 'up') pane.linked(this.link)
    const held = this.pendingOutput.get(paneId)
    this.pendingOutput.delete(paneId)
    if (held) {
      if (keepEarlyOutput) pane.holdEarlyOutput(held.join(''))
      else pane.skipEarlyOutput(held.join(''))
    }
    return pane
  }

  private handle(event: ControlEvent): void {
    if (event.type === 'reply') {
      const waiter = this.waiters.shift()
      if (!waiter) return
      waiter.onReply?.()
      if (event.ok) waiter.resolve(event.lines)
      else waiter.reject(new Error(event.lines.join('\n') || 'tmux command failed'))
    } else if (event.type === 'output') {
      const pane = this.panes.get(event.pane)
      if (pane) pane.deliver(event.data)
      else this.holdOutput(event.pane, event.data)
    } else if (event.type === 'subscription') {
      const pane = this.panes.get(event.pane)
      if (!pane) return
      if (event.name === COMMAND_SUBSCRIPTION) pane.setForeground(event.value)
      else if (event.name === DEAD_SUBSCRIPTION) {
        const code = parseExit(event.value)
        if (code !== null) pane.died(code)
        else if (event.value.startsWith('1:')) void this.reapedExit(pane)
      }
    }
  }

  private async attach(): Promise<void> {
    const { tmux, args, env } = this.launch
    const client: ControlClient = new ControlClient(tmux, args, env, {
      onEvent: (event) => {
        if (this.client === client) this.handle(event)
      },
      onEnd: (end) => this.clientEnded(client, end),
    })
    this.client = client
    try {
      await this.command(
        `refresh-client -B ${tmuxQuote(`${DEAD_SUBSCRIPTION}:%*:#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}`)}`,
      )
      await this.command(
        `refresh-client -B ${tmuxQuote(`${COMMAND_SUBSCRIPTION}:%*:#{pane_current_command}`)}`,
      )
      const [pid] = await this.command(`display-message -p ${tmuxQuote('#{pid}')}`)
      this.serverPid = Number(pid) || this.serverPid
    } catch (err) {
      if (this.client === client) this.dropClient()
      throw err
    }
  }

  private dropClient(): void {
    this.client?.stop()
    this.client = null
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('tmux control ended'))
  }

  private clientEnded(client: ControlClient, end: ControlEnd): void {
    if (this.client !== client) return
    this.dropClient()
    this.log('tmux-control-ended', {
      reason: end.reason,
      code: String(end.code),
      signal: String(end.signal),
      stderr: end.stderr,
      cause: this.suspended ? 'suspend' : this.leaving ? 'leaving' : 'lost',
    })
    if (this.closed) return
    if (this.leaving) this.gone()
    else if (!this.suspended && this.attached) void this.reconnect()
  }

  private async reconnect(): Promise<void> {
    if (this.closed || this.reconnecting) return
    this.reconnecting = true
    this.setLink('reconnecting')
    const began = Date.now()
    try {
      while (!this.closed && !this.suspended) {
        if (this.serverPid > 0 && !processAlive(this.serverPid)) {
          this.log('tmux-server-gone', {})
          this.gone()
          return
        }
        try {
          await within(RECONNECT_MS, this.attach())
          await this.resync()
          this.log('tmux-control-reconnected', { ms: String(Date.now() - began) })
          this.setLink('up')
          return
        } catch (err) {
          this.dropClient()
          if (Date.now() - began >= RECONNECT_MS) {
            this.log('tmux-reconnect-failed', {
              error: err instanceof Error ? err.message : String(err),
            })
            this.setLink('failed')
            return
          }
          await sleep(RECONNECT_PAUSE_MS)
        }
      }
    } finally {
      this.reconnecting = false
    }
  }

  private async resync(): Promise<void> {
    const windows = new Map((await this.windows()).map((w) => [w.paneId, w]))
    for (const pane of [...this.panes.values()]) {
      const window = windows.get(pane.paneId)
      if (!window) pane.died(LOST_EXIT_CODE)
      else if (window.dead) void this.reapedExit(pane)
      else void pane.redraw().catch(() => undefined)
    }
  }

  private setLink(state: KeptLink): void {
    this.link = state
    for (const pane of this.panes.values()) pane.linked(state)
  }

  private async reapedExit(pane: TmuxPane): Promise<void> {
    for (let tries = 0; tries < EXIT_POLL_TRIES; tries++) {
      await sleep(EXIT_POLL_MS)
      if (this.closed || pane.hasExited) return
      this.nudgeReaper()
      const lines = await this.command(
        `display-message -p -t ${pane.paneId} ${tmuxQuote(DEAD_FORMAT)}`,
      ).catch(() => null)
      if (lines === null) return
      const code = parseExit(lines[0] ?? '')
      if (code !== null) {
        pane.died(code)
        return
      }
    }
    pane.died(LOST_EXIT_CODE)
  }

  private nudgeReaper(): void {
    if (this.serverPid <= 0) return
    try {
      process.kill(this.serverPid, 'SIGCHLD')
    } catch {}
  }

  private holdOutput(pane: string, data: string): void {
    const held = this.pendingOutput.get(pane) ?? []
    if (held.length >= PENDING_OUTPUT_CAP) return
    held.push(data)
    this.pendingOutput.set(pane, held)
  }

  private gone(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('tmux is gone'))
    this.dropClient()
    for (const pane of [...this.panes.values()]) pane.lost()
    this.panes.clear()
    this.onGone()
  }
}
