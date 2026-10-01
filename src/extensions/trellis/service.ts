import { type ChildProcess, spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  type ExtensionIcon,
  type SidebarTone,
  type ToolRun,
  nextBackoff,
  runTool,
} from '@aurigax-ai/pine-extension-sdk'
import { type Strings, stringsFor } from './strings'
import {
  ALL_NOTIFY_KINDS,
  type CardCounts,
  type NotifyKinds,
  type TrellisEvent,
  type TrellisProject,
  cardPath,
  countCards,
  findProject,
  needsUser,
  parseCards,
  parseColumns,
  parseDaemonStatus,
  parseError,
  parseEventLine,
  parseUiInfo,
  projectOfRef,
} from './trellis'

export interface WorkspaceRef {
  workspaceId: string
  workDir: string
}

export interface TrellisHost {
  listWorkspaces: () => Promise<WorkspaceRef[]>
  setWorkspaceChip: (chip: {
    workspaceId: string
    id: string
    text: string
    tooltip: string
    icon: ExtensionIcon
    tone: SidebarTone
    command: string
  }) => Promise<{ ok: boolean }>
  clearWorkspaceChip: (workspaceId: string, id: string) => Promise<unknown>
  notifyPanel: (title: string, body?: string, path?: string) => Promise<unknown>
  log: (line: string) => void
}

export interface TrellisServiceOptions {
  host: TrellisHost
  home: string
  consumer: string
  bin?: string
  now?: () => number
  uiStartTimeoutMs?: number
  uiProbeMs?: number
  followRestartBaseMs?: number
}

const CARDS_CHIP = 'cards'
const OPEN_COMMAND = 'open'
const PRIME_PAGE = 5000
const PRIME_MAX_PAGES = 50
const ACK_DELAY_MS = 2000
const FOLLOW_RESTART_MAX_MS = 5 * 60_000
const FOLLOW_HEALTHY_MS = 60_000

export const UNKNOWN_PROJECT_RETRIES = 5
export const UNKNOWN_PROJECT_RETRY_MS = 1000

export class TrellisUnavailable extends Error {
  constructor(
    readonly code: 'not-installed' | 'ui-failed',
    message: string,
  ) {
    super(message)
  }
}

export class TrellisService {
  private readonly bin: string
  private installed: boolean | null = null
  private ownedUi: ChildProcess | null = null
  private uiUrl: string | null = null
  private uiStarting: Promise<string> | null = null
  private shown = new Set<string>()
  private projects = new Map<string, TrellisProject>()
  private workspacesKnown = false
  private follower: ChildProcess | null = null
  private followFailures = 0
  private followTimer: ReturnType<typeof setTimeout> | null = null
  private ackTimer: ReturnType<typeof setTimeout> | null = null
  private pendingAck: number | null = null
  private stopped = false
  locale = 'en'
  notifyKinds: NotifyKinds = ALL_NOTIFY_KINDS

  constructor(private readonly opts: TrellisServiceOptions) {
    this.bin = opts.bin ?? 'trellis'
  }

  get strings(): Strings {
    return stringsFor(this.locale)
  }

  private run(args: string[], cwd?: string, timeoutMs?: number): Promise<ToolRun> {
    return runTool(this.bin, args, { cwd, timeoutMs })
  }

  async isInstalled(): Promise<boolean> {
    if (this.installed !== null) return this.installed
    const res = await this.run(['version', '--json'], undefined, 5000)
    this.installed = !res.missing && res.code === 0
    return this.installed
  }

  owned(): boolean {
    return this.ownedUi !== null
  }

  async counts(project: TrellisProject): Promise<CardCounts | null> {
    const scope = ['--project', project.project]
    if (project.board) scope.push('--board', project.board)
    const [cards, columns] = await Promise.all([
      this.run(['card', 'ls', '--json', '--all', ...scope]),
      this.run(['column', 'ls', '--json', ...scope]),
    ])
    const parsedCards = cards.code === 0 ? parseCards(cards.stdout) : null
    const parsedColumns = columns.code === 0 ? parseColumns(columns.stdout) : null
    if (!parsedCards || !parsedColumns) return null
    return countCards(parsedCards, parsedColumns, (this.opts.now ?? Date.now)())
  }

  projectFor(workDir: string | undefined): TrellisProject | null {
    return workDir ? findProject(workDir, this.opts.home) : null
  }

  async refreshSidebar(): Promise<void> {
    if (this.stopped) return
    if (!(await this.isInstalled())) return this.clearSidebar()
    let workspaces: WorkspaceRef[]
    try {
      workspaces = await this.opts.host.listWorkspaces()
      this.workspacesKnown = true
    } catch (err) {
      this.workspacesKnown = false
      this.opts.host.log(`workspace list unavailable: ${(err as Error).message}`)
      return this.clearSidebar()
    }
    this.projects = this.projectsOf(workspaces)
    const byProject = new Map<string, Promise<CardCounts | null>>()
    const next = new Set<string>()
    for (const [workspaceId, project] of this.projects) {
      const key = `${project.project}/${project.board ?? ''}`
      if (!byProject.has(key)) byProject.set(key, this.counts(project))
      const counts = await byProject.get(key)
      if (!counts) continue
      const res = await this.opts.host.setWorkspaceChip({
        workspaceId,
        id: CARDS_CHIP,
        text: String(counts.open),
        tooltip: this.strings.sidebar(counts),
        icon: 'kanban',
        tone: counts.claimed > 0 ? 'brand' : 'neutral',
        command: OPEN_COMMAND,
      })
      if (res.ok) next.add(workspaceId)
    }
    for (const workspaceId of this.shown) {
      if (!next.has(workspaceId)) await this.opts.host.clearWorkspaceChip(workspaceId, CARDS_CHIP)
    }
    this.shown = next
  }

  private async clearSidebar(): Promise<void> {
    for (const workspaceId of this.shown) {
      await this.opts.host.clearWorkspaceChip(workspaceId, CARDS_CHIP)
    }
    this.shown.clear()
  }

  private projectsOf(workspaces: WorkspaceRef[]): Map<string, TrellisProject> {
    const projects = new Map<string, TrellisProject>()
    for (const workspace of workspaces) {
      const project = this.projectFor(workspace.workDir)
      if (project) projects.set(workspace.workspaceId, project)
    }
    return projects
  }

  private async isOpenProject(project: string | null): Promise<boolean> {
    const open = this.openProjects()
    if (!open) return true
    if (project && open.has(project)) return true
    try {
      this.projects = this.projectsOf(await this.opts.host.listWorkspaces())
    } catch {
      return true
    }
    return project !== null && (this.openProjects()?.has(project) ?? false)
  }

  openProjects(): Set<string> | null {
    if (!this.workspacesKnown) return null
    return new Set([...this.projects.values()].map((p) => p.project))
  }

  async ensureUi(): Promise<string> {
    if (!(await this.isInstalled())) {
      throw new TrellisUnavailable('not-installed', this.strings.notInstalled)
    }
    if (this.uiUrl && (this.ownedUi || (await this.daemonUrl()) === this.uiUrl)) return this.uiUrl
    this.uiUrl = null
    if (!this.uiStarting) {
      this.uiStarting = this.startUi().finally(() => {
        this.uiStarting = null
      })
    }
    return this.uiStarting
  }

  private async daemonUrl(): Promise<string | null> {
    const res = await this.run(['daemon', 'status', '--json'], undefined, 5000)
    const status = res.code === 0 ? parseDaemonStatus(res.stdout) : null
    return status?.running ? status.url : null
  }

  private startUi(): Promise<string> {
    const probeMs = this.opts.uiProbeMs ?? 1500
    const timeoutMs = this.opts.uiStartTimeoutMs ?? 10_000
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const child = spawn(this.bin, ['ui', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const settle = (err: Error | null, url?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(probe)
        if (err) reject(err)
        else {
          this.uiUrl = url ?? null
          resolve(url ?? '')
        }
      }
      child.stdout.on('data', (c: Buffer) => {
        if (stdout.length < 65_536) stdout += c.toString('utf8')
      })
      child.stderr.on('data', (c: Buffer) => {
        stderr = (stderr + c.toString('utf8')).slice(-4096)
      })
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') this.installed = false
        settle(new TrellisUnavailable('not-installed', this.strings.notInstalled))
      })
      child.on('exit', (code) => {
        if (this.ownedUi === child) {
          this.ownedUi = null
          this.uiUrl = null
        }
        const info = parseUiInfo(stdout)
        if (code === 0 && info) return settle(null, info.url)
        const message = parseError(stderr)?.message ?? this.strings.uiFailed
        settle(new TrellisUnavailable('ui-failed', message))
      })
      const probe = setTimeout(async () => {
        if (settled) return
        this.ownedUi = child
        const deadline = Date.now() + timeoutMs
        while (!settled && Date.now() < deadline && !this.stopped) {
          const url = await this.daemonUrl()
          if (url) return settle(null, url)
          await sleep(300)
        }
        if (!settled) {
          this.stopOwnedUi()
          settle(new TrellisUnavailable('ui-failed', this.strings.uiFailed))
        }
      }, probeMs)
    })
  }

  private stopOwnedUi(): void {
    const child = this.ownedUi
    this.ownedUi = null
    this.uiUrl = null
    if (child && child.exitCode === null) child.kill('SIGTERM')
  }

  async init(dir: string): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
    if (!(await this.isInstalled())) return { ok: false, message: this.strings.notInstalled }
    const res = await this.run(['init', '--json'], dir, 30_000)
    if (res.code !== 0) {
      return {
        ok: false,
        message: parseError(res.stderr)?.message ?? (res.stderr.trim() || 'failed'),
      }
    }
    let key = ''
    try {
      const parsed = JSON.parse(res.stdout) as { project?: { key?: unknown } }
      if (typeof parsed.project?.key === 'string') key = parsed.project.key
    } catch {}
    void this.refreshSidebar()
    return { ok: true, text: this.strings.initDone(key, dir) }
  }

  async startEvents(): Promise<void> {
    if (this.stopped || this.follower || !(await this.isInstalled())) return
    try {
      if (!(await this.consumerExists())) await this.primeConsumer()
    } catch (err) {
      this.opts.host.log(`events: ${(err as Error).message}`)
      return this.scheduleFollow()
    }
    this.follow()
  }

  private async consumerExists(): Promise<boolean> {
    const res = await this.run(['events', 'consumers', '--json'])
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'events consumers failed')
    const list = JSON.parse(res.stdout || '[]') as { name?: unknown }[]
    return Array.isArray(list) && list.some((c) => c?.name === this.opts.consumer)
  }

  private async primeConsumer(): Promise<void> {
    for (let page = 0; page < PRIME_MAX_PAGES; page++) {
      const res = await this.run(
        [
          'events',
          '--consumer',
          this.opts.consumer,
          '--json',
          '--all-projects',
          '--limit',
          `${PRIME_PAGE}`,
        ],
        undefined,
        60_000,
      )
      if (res.code !== 0) throw new Error(res.stderr.trim() || 'events failed')
      let last: number | null = null
      let count = 0
      for (const line of res.stdout.split('\n')) {
        const ev = parseEventLine(line)
        if (ev && !('gap' in ev)) {
          last = ev.seq
          count += 1
        }
      }
      if (last !== null) await this.ack(last)
      if (count < PRIME_PAGE) return
    }
  }

  private async ack(seq: number): Promise<void> {
    await this.run(['events', 'ack', this.opts.consumer, `${seq}`])
  }

  private scheduleAck(seq: number): void {
    this.pendingAck = Math.max(seq, this.pendingAck ?? 0)
    if (this.ackTimer) return
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null
      const target = this.pendingAck
      this.pendingAck = null
      if (target !== null) void this.ack(target)
    }, ACK_DELAY_MS)
  }

  private follow(): void {
    const started = Date.now()
    const child = spawn(
      this.bin,
      ['events', '--consumer', this.opts.consumer, '--json', '--all-projects', '--follow'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    this.follower = child
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        this.onEventLine(line)
        nl = buffer.indexOf('\n')
      }
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') this.installed = false
    })
    child.on('close', () => {
      if (this.follower !== child) return
      this.follower = null
      if (this.stopped || this.installed === false) return
      if (Date.now() - started > FOLLOW_HEALTHY_MS) this.followFailures = 0
      this.scheduleFollow()
    })
  }

  private scheduleFollow(): void {
    if (this.stopped || this.followTimer) return
    this.followFailures += 1
    const delay = nextBackoff(
      this.followFailures - 1,
      this.opts.followRestartBaseMs ?? 2000,
      FOLLOW_RESTART_MAX_MS,
    )
    this.followTimer = setTimeout(() => {
      this.followTimer = null
      void this.startEvents()
    }, delay)
  }

  followRestarts(): number {
    return this.followFailures
  }

  onEventLine(line: string): void {
    const ev = parseEventLine(line)
    if (!ev || 'gap' in ev) return
    this.scheduleAck(ev.seq)
    void this.handleEvent(ev)
  }

  private async handleEvent(ev: TrellisEvent, attempt = 0): Promise<void> {
    if (!(await this.isOpenProject(projectOfRef(ev.ref)))) {
      if (attempt < UNKNOWN_PROJECT_RETRIES && !this.stopped) {
        setTimeout(() => void this.handleEvent(ev, attempt + 1), UNKNOWN_PROJECT_RETRY_MS)
      }
      return
    }
    if (ev.entity === 'card') this.scheduleRefresh()
    const needs = needsUser(ev, this.notifyKinds)
    if (!needs) return
    const s = this.strings
    void this.opts.host.notifyPanel(
      needs.kind === 'blocked' ? s.blockedTitle : s.reviewTitle,
      `${ev.ref} ${ev.title}`.trim(),
      cardPath(ev.ref) ?? undefined,
    )
  }

  private refreshTimer: ReturnType<typeof setTimeout> | null = null

  scheduleRefresh(delayMs = 1000): void {
    if (this.refreshTimer || this.stopped) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refreshSidebar()
    }, delayMs)
  }

  stop(): void {
    this.stopped = true
    for (const t of [this.followTimer, this.ackTimer, this.refreshTimer]) if (t) clearTimeout(t)
    this.follower?.kill('SIGTERM')
    this.follower = null
    this.stopOwnedUi()
  }
}
