import type { ExtensionSidebarItem, WorkspaceChip } from '../../shared/extensions'
import {
  type CoreItems,
  GIT_BRANCH_CHIP,
  GIT_DIFF_STATS_CHIP,
  GIT_SHOW_COMMAND,
  GIT_SOURCE,
  type GitSettings,
  NO_CORE_ITEMS,
  type RepoStatus,
} from '../../shared/git'
import type { PaneEntry, WorkspaceEntry } from '../panes/paneList'
import { WatchSets } from '../platform/watchSets'
import { lineChanges, readStatus, repoRoot } from './repo'
import { branchChipText, branchLabel, diffStatsChipText } from './status'
import { WorkspaceCwds } from './workspaceCwds'

const SIDEBAR_KEY = 'branch'
const REFRESH_DEBOUNCE_MS = 300
const REFRESH_EVENTS: ReadonlySet<string> = new Set([
  'cwd.changed',
  'command.finished',
  'pane.created',
  'pane.closed',
])

export const GIT_ITEMS_CHANNEL = 'git:items'
export const GIT_CHANGED_CHANNEL = 'git:changed'

export interface Repo {
  root: string
  status: RepoStatus
}

export async function repoAt(cwd: string): Promise<Repo | null> {
  const root = await repoRoot(cwd)
  if (!root) return null
  return { root, status: await readStatus(root) }
}

export interface GitServiceDeps {
  settings: () => GitSettings
  listWorkspaces: () => Promise<WorkspaceEntry[]>
  listPanes: () => Promise<PaneEntry[]>
  send: (windowId: string, channel: string, payload: unknown) => void
  repoAt?: (cwd: string) => Promise<Repo | null>
  diffStats?: (repo: Repo) => Promise<string>
  log?: (line: string) => void
}

interface Shown {
  repo: Repo
  diffStats: string
}

function diffStatsOf(repo: Repo): Promise<string> {
  const untracked = repo.status.changes.filter((c) => c.area === 'untracked').map((c) => c.path)
  return lineChanges(repo.root, untracked).then(diffStatsChipText)
}

function itemsFor(workspaceId: string, shown: Shown): CoreItems {
  const sidebar: ExtensionSidebarItem[] = [
    {
      extId: GIT_SOURCE,
      workspaceId,
      key: SIDEBAR_KEY,
      text: branchLabel(shown.repo.status.branch),
      icon: 'git-branch',
      tone: 'neutral',
      kind: 'location',
    },
  ]
  const workspaceChips: WorkspaceChip[] = []
  const branch = branchChipText(shown.repo.status.branch)
  if (branch) {
    workspaceChips.push({
      extId: GIT_SOURCE,
      workspaceId,
      id: GIT_BRANCH_CHIP,
      text: branch,
      tone: 'neutral',
      command: GIT_SHOW_COMMAND,
    })
  }
  if (shown.diffStats) {
    workspaceChips.push({
      extId: GIT_SOURCE,
      workspaceId,
      id: GIT_DIFF_STATS_CHIP,
      text: shown.diffStats,
      tone: 'neutral',
    })
  }
  return { sidebar, paneChips: [], workspaceChips }
}

export class GitService {
  private watches = new WatchSets()
  private cwds = new WorkspaceCwds()
  private settings: GitSettings
  private timer: ReturnType<typeof setTimeout> | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private pollMs = 0
  private focused = true
  private running = false
  private again = false
  private sent = new Map<string, string>()
  private signature = ''

  constructor(private readonly deps: GitServiceDeps) {
    this.settings = deps.settings()
  }

  get active(): boolean {
    return this.settings.enabled && !this.watches.empty
  }

  get polling(): boolean {
    return this.poll !== null
  }

  get pending(): boolean {
    return this.timer !== null
  }

  watch(windowId: string, workspaceIds: unknown): void {
    if (this.watches.set(windowId, workspaceIds)) this.apply()
  }

  windowGone(windowId: string): void {
    this.sent.delete(windowId)
    if (this.watches.drop(windowId)) this.apply()
  }

  settingsChanged(): void {
    this.settings = this.deps.settings()
    this.apply()
    this.announceChange()
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    if (!this.active) return
    this.armPoll()
    if (focused) this.schedule(0)
  }

  activity(type: string): void {
    if (this.active && REFRESH_EVENTS.has(type)) this.schedule()
  }

  touched(): void {
    this.announceChange()
    if (this.active) this.schedule(0)
  }

  stop(): void {
    this.halt()
  }

  async cwdOf(workspaceId: string): Promise<string | null> {
    const [workspaces, panes] = await Promise.all([
      this.deps.listWorkspaces(),
      this.deps.listPanes(),
    ])
    return this.cwds.resolve(workspaces, panes).get(workspaceId) ?? null
  }

  private apply(): void {
    if (!this.active) {
      this.halt()
      this.clear()
      return
    }
    this.armPoll()
    this.schedule(0)
  }

  private halt(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    this.again = false
  }

  private clear(): void {
    this.signature = ''
    for (const windowId of this.sent.keys()) {
      this.deps.send(windowId, GIT_ITEMS_CHANNEL, NO_CORE_ITEMS)
    }
    this.sent.clear()
  }

  private armPoll(): void {
    const ms = this.settings.pollSeconds * 1000
    if (this.poll && this.focused && this.pollMs === ms) return
    if (this.poll) clearInterval(this.poll)
    this.pollMs = ms
    this.poll = this.focused ? setInterval(() => void this.refresh(), ms) : null
  }

  private schedule(delay = REFRESH_DEBOUNCE_MS): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, delay)
  }

  private announceChange(): void {
    for (const [windowId] of this.watches.windows()) {
      this.deps.send(windowId, GIT_CHANGED_CHANNEL, null)
    }
  }

  async refresh(): Promise<void> {
    if (!this.active) return
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      const shown = await this.read(this.watches.union())
      if (this.active) this.publish(shown)
    } catch (err) {
      this.deps.log?.(err instanceof Error ? err.message : String(err))
    } finally {
      this.running = false
      if (this.again) {
        this.again = false
        if (this.active) this.schedule()
      }
    }
  }

  private async read(watched: ReadonlySet<string>): Promise<Map<string, Shown>> {
    const [workspaces, panes] = await Promise.all([
      this.deps.listWorkspaces(),
      this.deps.listPanes(),
    ])
    const cwds = this.cwds.resolve(workspaces, panes)
    const repos = new Map<string, Promise<Repo | null>>()
    const stats = new Map<string, Promise<string>>()
    const readRepo = this.deps.repoAt ?? repoAt
    const readStats = this.deps.diffStats ?? diffStatsOf
    const out = new Map<string, Shown>()
    for (const workspaceId of watched) {
      const cwd = cwds.get(workspaceId)
      if (!cwd) continue
      let found = repos.get(cwd)
      if (!found) {
        found = readRepo(cwd).catch(() => null)
        repos.set(cwd, found)
      }
      const repo = await found
      if (!repo) continue
      let diffStats = ''
      if (this.settings.showDiffStats) {
        let counted = stats.get(repo.root)
        if (!counted) {
          counted = readStats(repo).catch(() => '')
          stats.set(repo.root, counted)
        }
        diffStats = await counted
      }
      out.set(workspaceId, { repo, diffStats })
    }
    return out
  }

  private publish(shown: Map<string, Shown>): void {
    const watching = new Map(this.watches.windows())
    for (const windowId of [...this.sent.keys()]) {
      if (watching.has(windowId)) continue
      this.sent.delete(windowId)
      this.deps.send(windowId, GIT_ITEMS_CHANNEL, NO_CORE_ITEMS)
    }
    for (const [windowId, ids] of watching) {
      const items: CoreItems = { sidebar: [], paneChips: [], workspaceChips: [] }
      for (const workspaceId of ids) {
        const one = shown.get(workspaceId)
        if (!one) continue
        const own = itemsFor(workspaceId, one)
        items.sidebar.push(...own.sidebar)
        items.workspaceChips.push(...own.workspaceChips)
      }
      const text = JSON.stringify(items)
      if (this.sent.get(windowId) === text) continue
      this.sent.set(windowId, text)
      this.deps.send(windowId, GIT_ITEMS_CHANNEL, items)
    }
    const signature = [...shown]
      .map(([workspaceId, one]) => `${workspaceId}\u0000${JSON.stringify(one.repo)}`)
      .sort()
      .join('\n')
    if (signature === this.signature) return
    this.signature = signature
    this.announceChange()
  }
}
