import { type ChildProcessWithoutNullStreams, type StdioOptions, spawn } from 'node:child_process'
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processAlive } from '../platform/processAlive'
import { type ControlEvent, ControlModeParser } from './controlMode'
import { SCREEN_INFO_FORMAT, screenReplay } from './screenReplay'
import { type NewWindowSpec, newWindowCommand, sendKeysCommands, tmuxQuote } from './tmuxCommand'
import { tmuxConf } from './tmuxConf'

const TMUX_SESSION = 'ostia'
const HOLDER_META = 'holder'
const META_OPTION = '@ostia-meta'
const DEAD_SUBSCRIPTION = 'ostia-dead'
const DEAD_FORMAT = '#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}'
const EXIT_POLL_MS = 50
const EXIT_POLL_TRIES = 40
const LOST_EXIT_CODE = 1
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
  onReply?: () => void
}

const RUN_TIMEOUT_MS = 5000
const SERVER_EXIT_WAIT_MS = 3000
const SERVER_EXIT_POLL_MS = 20

async function processGone(pid: number, ms: number): Promise<void> {
  if (pid <= 0) return
  const end = Date.now() + ms
  while (processAlive(pid) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, SERVER_EXIT_POLL_MS))
  }
}
const RUN_DRAIN_MS = 200
const RUN_STDERR_CAP = 2000

function inheritedFds(): number[] {
  try {
    return readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd')
      .map(Number)
      .filter((fd) => Number.isInteger(fd) && fd > 2)
  } catch {
    return []
  }
}

function withoutInheritedFds(first: ('pipe' | 'ignore')[], devNull: number): StdioOptions {
  const highest = Math.max(2, ...inheritedFds())
  return [...first, ...Array.from({ length: highest - 2 }, () => devNull)]
}

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
  private readonly parser: ControlModeParser
  private closed = false
  private serverPid = 0

  private constructor(
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
    const base = ['-u', '-S', socket, '-f', conf]
    const env = serverEnv(options.env)
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
    }
    const devNull = openSync('/dev/null', 'r+')
    const client = spawn(options.tmux, [...base, '-C', 'attach-session', '-t', TMUX_SESSION], {
      env,
      stdio: withoutInheritedFds(['pipe', 'pipe', 'pipe'], devNull),
    }) as ChildProcessWithoutNullStreams
    closeSync(devNull)
    const server = new TmuxServer(socket, client, onGone)
    await server.command(
      `refresh-client -B ${tmuxQuote(`${DEAD_SUBSCRIPTION}:%*:#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}`)}`,
    )
    await server.command(
      `refresh-client -B ${tmuxQuote(`${COMMAND_SUBSCRIPTION}:%*:#{pane_current_command}`)}`,
    )
    const [pid] = await server.command(`display-message -p ${tmuxQuote('#{pid}')}`)
    server.serverPid = Number(pid) || 0
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
    if (this.closed) return Promise.reject(new Error('tmux is gone'))
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
    this.client.stdin.write(`${lines.join(' ; ')}\n`)
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
    await this.command('kill-server').catch(() => undefined)
    this.close()
    await processGone(this.serverPid, SERVER_EXIT_WAIT_MS)
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
    keepEarlyOutput: boolean,
  ): TmuxPane {
    const pane = new TmuxPane(this, windowId, paneId, pid, cols, rows)
    this.panes.set(paneId, pane)
    const held = this.pendingOutput.get(paneId)
    this.pendingOutput.delete(paneId)
    if (held && keepEarlyOutput) pane.unheard = held.join('')
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
      if (event.name === COMMAND_SUBSCRIPTION) pane.foreground = event.value
      else if (event.name === DEAD_SUBSCRIPTION) {
        const code = parseExit(event.value)
        if (code !== null) pane.died(code)
        else if (event.value.startsWith('1:')) void this.reapedExit(pane)
      }
    } else if (event.type === 'exit') {
      this.gone()
    }
  }

  private async reapedExit(pane: TmuxPane): Promise<void> {
    for (let tries = 0; tries < EXIT_POLL_TRIES; tries++) {
      await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS))
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
    for (const pane of [...this.panes.values()]) pane.lost()
    this.panes.clear()
    this.onGone()
  }
}

type Listener<T> = (value: T) => void

interface Disposable {
  dispose(): void
}

export class TmuxPane {
  foreground = ''
  private readonly dataListeners = new Set<Listener<string>>()
  private readonly exitListeners = new Set<Listener<{ exitCode: number; signal?: number }>>()
  private exited = false
  private detached = false
  private held: string[] | null = null
  unheard = ''

  constructor(
    private readonly server: TmuxServer,
    readonly windowId: string,
    readonly paneId: string,
    readonly pid: number,
    public cols: number,
    public rows: number,
  ) {}

  get hasExited(): boolean {
    return this.exited
  }

  get process(): string {
    return this.foreground
  }

  onData(listener: Listener<string>): Disposable {
    this.dataListeners.add(listener)
    const unheard = this.unheard
    this.unheard = ''
    if (unheard) listener(unheard)
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

  paste(text: string): void {
    if (this.exited || this.detached) return
    const buffer = tmuxQuote(`ostia-paste-${this.paneId}`)
    void this.server
      .batch([
        `set-buffer -b ${buffer} -- ${tmuxQuote(text)}`,
        `paste-buffer -d -p -r -b ${buffer} -t ${this.paneId}`,
      ])
      .catch(() => undefined)
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

  async snapshot(cols: number, rows: number): Promise<string> {
    this.held = []
    if (cols > 0 && rows > 0 && (cols !== this.cols || rows !== this.rows)) {
      this.cols = cols
      this.rows = rows
      this.server.send(`resize-window -t ${this.windowId} -x ${cols} -y ${rows}`)
    }
    const [[alternate = '0']] = await this.server.batch([
      `display-message -p -t ${this.paneId} "#{alternate_on}"`,
    ])
    const onAlternate = alternate === '1'
    const lines = [
      onAlternate
        ? `capture-pane -p -e -a -t ${this.paneId}`
        : `capture-pane -p -e -S - -t ${this.paneId}`,
      ...(onAlternate ? [`capture-pane -p -e -t ${this.paneId}`] : []),
      `display-message -p -t ${this.paneId} ${tmuxQuote(SCREEN_INFO_FORMAT)}`,
    ]
    const replies = await this.server.batch(lines, () => {
      this.held = []
    })
    const info = replies[replies.length - 1]?.join('') ?? ''
    return screenReplay(info, replies[0] ?? [], onAlternate ? (replies[1] ?? []) : null)
  }

  live(): void {
    const held = this.held
    this.held = null
    if (held && held.length > 0) this.deliver(held.join(''))
  }

  deliver(data: string): void {
    if (this.detached) return
    if (this.held) {
      this.held.push(data)
      return
    }
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
    for (const listener of this.exitListeners) listener({ exitCode: LOST_EXIT_CODE })
  }
}
