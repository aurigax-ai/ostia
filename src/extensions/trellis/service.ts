import { type ChildProcess, spawn } from 'node:child_process'
import {
  type ExtensionIcon,
  type SidebarTone,
  type Translate,
  nextBackoff,
  runTool,
} from '@aurigax-ai/pine-extension-sdk'
import { TrellisCli } from './cli'
import {
  ALL_NOTIFY_KINDS,
  type CardCounts,
  type NotifyKinds,
  type TrellisEvent,
  type TrellisProject,
  cardPath,
  countBoard,
  findProject,
  needsUser,
  parseEventLine,
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
  changed: () => void
  log: (line: string) => void
}

export interface TrellisServiceOptions {
  host: TrellisHost
  home: string
  consumer: string
  translate: (locale: string | undefined) => Translate
  bin?: string
  now?: () => number
  followRestartBaseMs?: number
  changeDelayMs?: number
}

const CARDS_CHIP = 'cards'
const OPEN_COMMAND = 'open'
const PRIME_PAGE = 5000
const PRIME_MAX_PAGES = 50
const ACK_DELAY_MS = 2000
const FOLLOW_RESTART_MAX_MS = 5 * 60_000
const FOLLOW_HEALTHY_MS = 60_000
const CHANGE_DELAY_MS = 250
const PANEL_ENTITIES = new Set(['card', 'comment', 'entry', 'board'])

export const UNKNOWN_PROJECT_RETRIES = 5
export const UNKNOWN_PROJECT_RETRY_MS = 1000

export type InitResult = { ok: true; text: string } | { ok: false; message: string }

export class TrellisService {
  readonly cli: TrellisCli
  private readonly bin: string
  private shown = new Set<string>()
  private projects = new Map<string, TrellisProject>()
  private workspacesKnown = false
  private follower: ChildProcess | null = null
  private followFailures = 0
  private followTimer: ReturnType<typeof setTimeout> | null = null
  private ackTimer: ReturnType<typeof setTimeout> | null = null
  private pendingAck: number | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private changeTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  locale = 'en'
  notifyKinds: NotifyKinds = ALL_NOTIFY_KINDS

  constructor(private readonly opts: TrellisServiceOptions) {
    this.bin = opts.bin ?? 'trellis'
    this.cli = new TrellisCli({ bin: this.bin })
  }

  get t(): Translate {
    return this.opts.translate(this.locale)
  }

  isInstalled(): Promise<boolean> {
    return this.cli.isInstalled()
  }

  async counts(project: TrellisProject): Promise<CardCounts | null> {
    const res = await this.cli.board({ project: project.project, board: project.board })
    return res.ok ? countBoard(res.value, (this.opts.now ?? Date.now)()) : null
  }

  chipTooltip(counts: CardCounts, t: Translate = this.t): string {
    return counts.claimed > 0
      ? t('chip.openClaimed', { open: counts.open, claimed: counts.claimed })
      : t('chip.open', { open: counts.open })
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
        tooltip: this.chipTooltip(counts),
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

  async init(dir: string): Promise<InitResult> {
    if (!(await this.isInstalled())) return { ok: false, message: this.t('notInstalled') }
    const res = await this.cli.init(dir)
    if (!res.ok) return { ok: false, message: res.error.message }
    const project = res.value.project as { key?: unknown } | undefined
    const key = typeof project?.key === 'string' ? project.key : ''
    this.changed()
    return {
      ok: true,
      text: key ? this.t('initDone', { key, dir }) : this.t('initDoneNoKey', { dir }),
    }
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
    const res = await runTool(this.bin, ['events', 'consumers', '--json'])
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'events consumers failed')
    const list = JSON.parse(res.stdout || '[]') as { name?: unknown }[]
    return Array.isArray(list) && list.some((c) => c?.name === this.opts.consumer)
  }

  private async primeConsumer(): Promise<void> {
    for (let page = 0; page < PRIME_MAX_PAGES; page++) {
      const res = await runTool(
        this.bin,
        [
          'events',
          '--consumer',
          this.opts.consumer,
          '--json',
          '--all-projects',
          '--limit',
          `${PRIME_PAGE}`,
        ],
        { timeoutMs: 60_000 },
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
    await runTool(this.bin, ['events', 'ack', this.opts.consumer, `${seq}`])
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
    child.on('error', () => {})
    child.on('close', () => {
      if (this.follower !== child) return
      this.follower = null
      if (this.stopped || this.cli.knownMissing()) return
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
    if (PANEL_ENTITIES.has(ev.entity)) this.changed()
    void this.handleEvent(ev)
  }

  private async handleEvent(ev: TrellisEvent, attempt = 0): Promise<void> {
    if (ev.entity !== 'card') return
    if (!(await this.isOpenProject(projectOfRef(ev.ref)))) {
      if (attempt < UNKNOWN_PROJECT_RETRIES && !this.stopped) {
        setTimeout(() => void this.handleEvent(ev, attempt + 1), UNKNOWN_PROJECT_RETRY_MS)
      }
      return
    }
    this.scheduleRefresh()
    const needs = needsUser(ev, this.notifyKinds)
    if (!needs) return
    const t = this.t
    void this.opts.host.notifyPanel(
      needs.kind === 'blocked' ? t('blockedTitle') : t('reviewTitle'),
      `${ev.ref} ${ev.title}`.trim(),
      cardPath(ev.ref) ?? undefined,
    )
  }

  scheduleRefresh(delayMs = 1000): void {
    if (this.refreshTimer || this.stopped) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refreshSidebar()
    }, delayMs)
  }

  changed(): void {
    this.scheduleRefresh()
    if (this.changeTimer || this.stopped) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      this.opts.host.changed()
    }, this.opts.changeDelayMs ?? CHANGE_DELAY_MS)
  }

  stop(): void {
    this.stopped = true
    for (const t of [this.followTimer, this.ackTimer, this.refreshTimer, this.changeTimer]) {
      if (t) clearTimeout(t)
    }
    this.follower?.kill('SIGTERM')
    this.follower = null
  }
}
