import type { KeptLink } from '../../shared/terminal/ptyApi'
import { SCREEN_INFO_FORMAT, screenReplay } from './screenReplay'
import { ScreenTitleFilter } from './screenTitleFilter'
import { encodeMeta, META_OPTION, sendKeysCommands, tmuxQuote } from './tmuxCommand'

export const LOST_EXIT_CODE = 1

const REDRAW_RESET = '\x1b[?1049l\x1b[0m\x1b[H\x1b[2J'

type Listener<T> = (value: T) => void

interface Disposable {
  dispose(): void
}

interface PaneServer {
  send(line: string): void
  command(line: string): Promise<string[]>
  batch(lines: string[], onLastReply?: () => void): Promise<string[][]>
  forget(pane: TmuxPane): void
  killWindow(windowId: string): Promise<void>
  retry(): void
}

export class TmuxPane {
  foreground = ''
  private readonly dataListeners = new Set<Listener<string>>()
  private readonly linkListeners = new Set<Listener<KeptLink>>()
  private link: KeptLink = 'up'
  private readonly exitListeners = new Set<Listener<{ exitCode: number; signal?: number }>>()
  private exited = false
  private detached = false
  private held: string[] | null = null
  unheard = ''
  private readonly titles = new ScreenTitleFilter()

  constructor(
    private readonly server: PaneServer,
    readonly windowId: string,
    readonly paneId: string,
    readonly pid: number,
    public cols: number,
    public rows: number,
  ) {}

  get hasExited(): boolean {
    return this.exited
  }

  private readonly foregroundWaiters = new Set<() => void>()

  setForeground(command: string): void {
    this.foreground = command
    const waiters = [...this.foregroundWaiters]
    this.foregroundWaiters.clear()
    for (const waiter of waiters) waiter()
  }

  afterForeground(waiter: () => void): void {
    this.foregroundWaiters.add(waiter)
  }

  get process(): string {
    return this.foreground
  }

  holdEarlyOutput(raw: string): void {
    this.unheard = this.titles.push(raw)
  }

  skipEarlyOutput(raw: string): void {
    this.titles.push(raw)
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

  get linkState(): KeptLink {
    return this.link
  }

  onLink(listener: Listener<KeptLink>): Disposable {
    this.linkListeners.add(listener)
    return { dispose: () => this.linkListeners.delete(listener) }
  }

  linked(state: KeptLink): void {
    if (this.link === state) return
    this.link = state
    for (const listener of this.linkListeners) listener(state)
  }

  retryLink(): void {
    this.server.retry()
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

  async shellPid(): Promise<number | null> {
    const [pid = ''] = await this.server.command(
      `display-message -p -t ${this.paneId} "#{pane_pid}"`,
    )
    const n = Number(pid)
    return Number.isInteger(n) && n > 0 ? n : null
  }

  async currentCommand(): Promise<string> {
    const [command = ''] = await this.server.command(
      `display-message -p -t ${this.paneId} "#{pane_current_command}"`,
    )
    this.foreground = command
    return command
  }

  async redraw(): Promise<void> {
    if (this.exited || this.detached) return
    let screen: string
    try {
      screen = await this.capture(this.cols, this.rows, false)
    } catch (err) {
      this.live()
      throw err
    }
    const held = this.held ?? []
    this.held = null
    this.emit(REDRAW_RESET + screen)
    if (held.length > 0) this.emit(held.join(''))
  }

  snapshot(cols: number, rows: number): Promise<string> {
    return this.capture(cols, rows, true)
  }

  private async capture(cols: number, rows: number, history: boolean): Promise<string> {
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
        : `capture-pane -p -e ${history ? '-S - ' : ''}-t ${this.paneId}`,
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
    if (held && held.length > 0) this.emit(held.join(''))
  }

  deliver(raw: string): void {
    if (this.detached) return
    this.emit(this.titles.push(raw))
  }

  private emit(data: string): void {
    if (this.detached || !data) return
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
