import { SCREEN_INFO_FORMAT, screenReplay } from './screenReplay'
import { ScreenTitleFilter } from './screenTitleFilter'
import { encodeMeta, META_OPTION, sendKeysCommands, tmuxQuote } from './tmuxCommand'

export const LOST_EXIT_CODE = 1

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
}

export class TmuxPane {
  foreground = ''
  private readonly dataListeners = new Set<Listener<string>>()
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

  async currentCommand(): Promise<string> {
    const [command = ''] = await this.server.command(
      `display-message -p -t ${this.paneId} "#{pane_current_command}"`,
    )
    this.foreground = command
    return command
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
