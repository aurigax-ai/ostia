import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ControlEvent, ControlModeParser } from './controlMode'
import { type NewWindowSpec, newWindowCommand, sendKeysCommands, tmuxQuote } from './tmuxCommand'
import { tmuxConf } from './tmuxConf'

export const TMUX_SESSION = 'ostia'
const HOLDER_META = 'holder'
const META_OPTION = '@ostia-meta'
const DEAD_SUBSCRIPTION = 'ostia-dead'
const COMMAND_SUBSCRIPTION = 'ostia-cmd'
const SERVER_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR']
const FIELD_SEPARATOR = '\t'
const PENDING_OUTPUT_CAP = 256

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
}

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
}

function run(tmux: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(tmux, args, { env, timeout: 5000 }, (err) => resolve(!err))
  })
}

function encodeMeta(meta: unknown): string {
  return Buffer.from(JSON.stringify(meta), 'utf8').toString('base64')
}

function decodeMeta(raw: string): unknown {
  if (!raw) return null
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function parseExit(value: string): number | null {
  const [dead, status, signal] = value.split(':')
  if (dead !== '1') return null
  if (status) return Number(status)
  return signal ? 128 + Number(signal) : 0
}

export class TmuxServer {
  private readonly waiters: Waiter[] = []
  private readonly panes = new Map<string, TmuxPane>()
  private readonly pendingOutput = new Map<string, string[]>()
  private readonly parser: ControlModeParser
  private closed = false

  private constructor(
    private readonly options: TmuxServerOptions,
    private readonly socket: string,
    private readonly client: ChildProcessWithoutNullStreams,
    private readonly onGone: () => void,
  ) {
    this.parser = new ControlModeParser((event) => this.handle(event))
    client.stdout.on('data', (chunk: Buffer) => this.parser.push(chunk))
    client.stderr.resume()
    client.on('exit', () => this.gone())
    client.stdin.on('error', () => this.gone())
  }

  static async connect(options: TmuxServerOptions, onGone: () => void): Promise<TmuxServer> {
    const uid = process.getuid?.() ?? 0
    const dir = ensureTmuxSocketDir(options.dir, uid)
    const socket = join(dir, options.name)
    const conf = join(dir, `${options.name}.conf`)
    writeFileSync(conf, tmuxConf(options.defaultTerminal), { mode: 0o600 })
    const base = ['-S', socket, '-f', conf]
    const env = serverEnv(options.env)
    if (!(await run(options.tmux, [...base, 'has-session', '-t', TMUX_SESSION], env))) {
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
      if (!started) throw new Error('tmux could not start its server')
    }
    const client = spawn(options.tmux, [...base, '-C', 'attach-session', '-t', TMUX_SESSION], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const server = new TmuxServer(options, socket, client, onGone)
    await server.command(
      `refresh-client -B ${tmuxQuote(`${DEAD_SUBSCRIPTION}:%*:#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}`)}`,
    )
    await server.command(
      `refresh-client -B ${tmuxQuote(`${COMMAND_SUBSCRIPTION}:%*:#{pane_current_command}`)}`,
    )
    return server
  }

  get socketPath(): string {
    return this.socket
  }

  get alive(): boolean {
    return !this.closed
  }

  command(line: string): Promise<string[]> {
    if (this.closed) return Promise.reject(new Error('tmux is gone'))
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject })
      this.client.stdin.write(`${line}\n`)
    })
  }

  send(line: string): void {
    void this.command(line).catch(() => undefined)
  }

  async spawn(
    spec: Omit<NewWindowSpec, 'session'> & { cols: number; rows: number; meta: unknown },
  ): Promise<TmuxPane> {
    await this.command(`set -t ${tmuxQuote(TMUX_SESSION)} default-size ${spec.cols}x${spec.rows}`)
    const [line] = await this.command(newWindowCommand({ ...spec, session: TMUX_SESSION }))
    const [windowId, paneId, pid] = (line ?? '').split(' ')
    if (!windowId || !paneId) throw new Error('tmux did not open a window')
    this.send(`set -w -t ${windowId} ${META_OPTION} ${tmuxQuote(encodeMeta(spec.meta))}`)
    return this.track(windowId, paneId, Number(pid), spec.cols, spec.rows)
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
    return this.track(window.windowId, window.paneId, window.pid, window.cols, window.rows)
  }

  killWindow(windowId: string): Promise<void> {
    return this.command(`kill-window -t ${windowId}`).then(
      () => undefined,
      () => undefined,
    )
  }

  async killServer(): Promise<void> {
    await this.command('kill-server').catch(() => undefined)
    this.close()
  }

  close(): void {
    if (this.closed) return
    this.client.stdin.end()
    this.gone()
  }

  forget(pane: TmuxPane): void {
    this.panes.delete(pane.paneId)
    this.parser.forgetPane(pane.paneId)
  }

  private track(
    windowId: string,
    paneId: string,
    pid: number,
    cols: number,
    rows: number,
  ): TmuxPane {
    const pane = new TmuxPane(this, windowId, paneId, pid, cols, rows)
    this.panes.set(paneId, pane)
    const held = this.pendingOutput.get(paneId)
    this.pendingOutput.delete(paneId)
    if (held) queueMicrotask(() => pane.deliver(held.join('')))
    return pane
  }

  private handle(event: ControlEvent): void {
    if (event.type === 'reply') {
      const waiter = this.waiters.shift()
      if (!waiter) return
      if (event.ok) waiter.resolve(event.lines)
      else waiter.reject(new Error(event.lines.join('\n') || 'tmux command failed'))
    } else if (event.type === 'output') {
      const pane = this.panes.get(event.pane)
      if (pane) pane.deliver(event.data)
      else this.holdOutput(event.pane, event.data)
    } else if (event.type === 'subscription') {
      const pane = this.panes.get(event.pane)
      if (!pane) return
      if (event.name === COMMAND_SUBSCRIPTION) pane.foreground = event.value
      else if (event.name === DEAD_SUBSCRIPTION) {
        const code = parseExit(event.value)
        if (code !== null) pane.died(code)
      }
    } else if (event.type === 'exit') {
      this.gone()
    }
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
    for (const pane of [...this.panes.values()]) pane.lost()
    this.panes.clear()
    this.onGone()
  }

  get defaultTerminal(): string {
    return this.options.defaultTerminal
  }
}

type Listener<T> = (value: T) => void

export interface Disposable {
  dispose(): void
}

export class TmuxPane {
  foreground = ''
  private readonly dataListeners = new Set<Listener<string>>()
  private readonly exitListeners = new Set<Listener<{ exitCode: number; signal?: number }>>()
  private exited = false
  private detached = false

  constructor(
    private readonly server: TmuxServer,
    readonly windowId: string,
    readonly paneId: string,
    readonly pid: number,
    public cols: number,
    public rows: number,
  ) {}

  get process(): string {
    return this.foreground
  }

  onData(listener: Listener<string>): Disposable {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  onExit(listener: Listener<{ exitCode: number; signal?: number }>): Disposable {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }

  write(data: string): void {
    if (this.exited || this.detached) return
    for (const line of sendKeysCommands(this.paneId, data)) this.server.send(line)
  }

  resize(cols: number, rows: number): void {
    if (this.exited || this.detached || cols <= 0 || rows <= 0) return
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.server.send(`resize-window -t ${this.windowId} -x ${cols} -y ${rows}`)
  }

  kill(): void {
    if (this.exited || this.detached) return
    this.detached = true
    this.server.forget(this)
    void this.server.killWindow(this.windowId)
  }

  detach(): void {
    this.detached = true
    this.server.forget(this)
  }

  setMeta(meta: unknown): void {
    if (this.exited || this.detached) return
    this.server.send(`set -w -t ${this.windowId} ${META_OPTION} ${tmuxQuote(encodeMeta(meta))}`)
  }

  capture(args: string): Promise<string[]> {
    return this.server.command(`capture-pane -p -t ${this.paneId} ${args}`)
  }

  query(format: string): Promise<string> {
    return this.server
      .command(`display-message -p -t ${this.paneId} ${tmuxQuote(format)}`)
      .then((lines) => lines.join('\n'))
  }

  deliver(data: string): void {
    if (this.detached) return
    for (const listener of this.dataListeners) listener(data)
  }

  died(exitCode: number): void {
    if (this.exited) return
    this.exited = true
    this.server.forget(this)
    void this.server.killWindow(this.windowId)
    if (this.detached) return
    for (const listener of this.exitListeners) listener({ exitCode })
  }

  lost(): void {
    if (this.exited) return
    this.exited = true
    if (this.detached) return
    for (const listener of this.exitListeners) listener({ exitCode: 1 })
  }
}
