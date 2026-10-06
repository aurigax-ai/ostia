import { lineChanges, readStatus, repoRoot } from '../extensions/git/repo'
import { type GitSettings, readGitSettings } from '../extensions/git/settings'
import {
  type RepoStatus,
  branchChipText,
  branchLabel,
  diffStatsChipText,
} from '../extensions/git/status'
import { WorkspaceCwds } from '../extensions/git/workspaces'
import type { PaneInfo, WorkspaceInfo } from '../extensions/sdk'
import { nextBackoff } from '../extensions/sdk/tool'
import type {
  ExtensionEventType,
  ExtensionResult,
  ExtensionSettingValues,
  ExtensionSidebarItem,
  WorkspaceChip,
} from '../shared/extensions'

export const GIT_EXTENSION = 'git'
const SIDEBAR_KEY = 'branch'
const BRANCH_CHIP = 'branch'
const DIFF_STATS_CHIP = 'diff-stats'
const REFRESH_DEBOUNCE_MS = 300
const CHIP_RETRY_MS = 300
const CHIP_RETRY_MAX_MS = 5000
const REFRESH_EVENTS: ReadonlySet<ExtensionEventType> = new Set([
  'cwd.changed',
  'command.finished',
  'pane.created',
  'pane.closed',
])

export interface GitBoardHost {
  isEnabled: (extId: string) => boolean
  settingValuesOf: (extId: string) => ExtensionSettingValues
  sidebarItems: () => ExtensionSidebarItem[]
  workspaceChips: () => WorkspaceChip[]
  publishSidebarItem: (extId: string, params: unknown) => ExtensionResult
  publishWorkspaceChip: (extId: string, params: unknown) => ExtensionResult
  onEvent: (listener: (type: ExtensionEventType, payload: unknown) => void) => () => void
  watch: (extId: string, listener: () => void) => () => void
}

export interface GitBoardDeps {
  host: GitBoardHost
  listWorkspaces: () => Promise<WorkspaceInfo[]>
  listPanes: () => Promise<PaneInfo[]>
  log?: (line: string) => void
}

interface Repo {
  root: string
  status: RepoStatus
}

async function repoAt(cwd: string): Promise<Repo | null> {
  const root = await repoRoot(cwd)
  if (!root) return null
  return { root, status: await readStatus(root) }
}

function chipKey(workspaceId: string, id: string): string {
  return `${workspaceId}\u0000${id}`
}

export class GitBoard {
  private cwds = new WorkspaceCwds()
  private settings: GitSettings = readGitSettings({})
  private timer: ReturnType<typeof setTimeout> | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private focused = true
  private running = false
  private again = false
  private chipRefusals = 0
  private unsubscribe: (() => void)[] = []

  constructor(private readonly deps: GitBoardDeps) {}

  start(): void {
    if (this.unsubscribe.length > 0) return
    this.unsubscribe = [
      this.deps.host.onEvent((type, payload) => {
        if (type === 'focus.changed') this.setFocused((payload as { focused: boolean }).focused)
        else if (REFRESH_EVENTS.has(type)) this.schedule()
      }),
      this.deps.host.watch(GIT_EXTENSION, () => this.applySettings()),
    ]
    this.applySettings()
    this.schedule(0)
  }

  stop(): void {
    for (const off of this.unsubscribe) off()
    this.unsubscribe = []
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  schedule(delay = REFRESH_DEBOUNCE_MS): void {
    if (this.unsubscribe.length === 0) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, delay)
  }

  private applySettings(): void {
    const next = readGitSettings(this.deps.host.settingValuesOf(GIT_EXTENSION))
    const repoll = next.pollMs !== this.settings.pollMs || !this.poll
    this.settings = next
    if (repoll) this.restartPoll()
    this.schedule()
  }

  private setFocused(focused: boolean): void {
    this.focused = focused
    this.restartPoll()
    if (focused) this.schedule(0)
  }

  private restartPoll(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = this.focused ? setInterval(() => void this.refresh(), this.settings.pollMs) : null
  }

  async refresh(): Promise<void> {
    if (!this.deps.host.isEnabled(GIT_EXTENSION)) return
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      const [workspaces, panes] = await Promise.all([
        this.deps.listWorkspaces(),
        this.deps.listPanes(),
      ])
      const repos = new Map<string, Promise<Repo | null>>()
      const repoFor = (cwd: string): Promise<Repo | null> => {
        let found = repos.get(cwd)
        if (!found) {
          found = repoAt(cwd).catch(() => null)
          repos.set(cwd, found)
        }
        return found
      }
      const cwds = this.cwds.resolve(workspaces, panes)
      this.syncSidebar(await this.branches(cwds, repoFor))
      this.syncChips(cwds, await this.chipTexts(cwds, repoFor))
    } catch (err) {
      this.deps.log?.(err instanceof Error ? err.message : String(err))
    } finally {
      this.running = false
      if (this.again) {
        this.again = false
        this.schedule()
      }
    }
  }

  private async branches(
    cwds: Map<string, string>,
    repoFor: (cwd: string) => Promise<Repo | null>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const [workspaceId, cwd] of cwds) {
      const repo = await repoFor(cwd)
      if (repo) out.set(workspaceId, branchLabel(repo.status.branch))
    }
    return out
  }

  private async chipTexts(
    cwds: Map<string, string>,
    repoFor: (cwd: string) => Promise<Repo | null>,
  ): Promise<Map<string, string>> {
    const stats = new Map<string, Promise<string>>()
    const statsFor = (repo: Repo): Promise<string> => {
      let found = stats.get(repo.root)
      if (!found) {
        const untracked = repo.status.changes
          .filter((c) => c.area === 'untracked')
          .map((c) => c.path)
        found = lineChanges(repo.root, untracked)
          .then(diffStatsChipText)
          .catch(() => '')
        stats.set(repo.root, found)
      }
      return found
    }
    const out = new Map<string, string>()
    for (const [workspaceId, cwd] of cwds) {
      const repo = await repoFor(cwd)
      if (!repo) continue
      const branch = branchChipText(repo.status.branch)
      if (branch) out.set(chipKey(workspaceId, BRANCH_CHIP), branch)
      if (this.settings.showDiffStats) {
        const diff = await statsFor(repo)
        if (diff) out.set(chipKey(workspaceId, DIFF_STATS_CHIP), diff)
      }
    }
    return out
  }

  private syncSidebar(next: Map<string, string>): void {
    const shown = new Map(
      this.deps.host
        .sidebarItems()
        .filter((i) => i.extId === GIT_EXTENSION && i.key === SIDEBAR_KEY && i.workspaceId)
        .map((i) => [i.workspaceId as string, i.text]),
    )
    for (const [workspaceId, text] of next) {
      if (shown.get(workspaceId) === text) continue
      this.deps.host.publishSidebarItem(GIT_EXTENSION, {
        workspaceId,
        key: SIDEBAR_KEY,
        text,
        icon: 'git-branch',
        kind: 'location',
      })
    }
    for (const workspaceId of shown.keys()) {
      if (next.has(workspaceId)) continue
      this.deps.host.publishSidebarItem(GIT_EXTENSION, { workspaceId, key: SIDEBAR_KEY, text: '' })
    }
  }

  private syncChips(cwds: Map<string, string>, next: Map<string, string>): void {
    const shown = new Map(
      this.deps.host
        .workspaceChips()
        .filter((c) => c.extId === GIT_EXTENSION)
        .map((c) => [chipKey(c.workspaceId, c.id), c.text]),
    )
    let refused = false
    for (const [key, text] of next) {
      if (shown.get(key) === text) continue
      const [workspaceId, id] = key.split('\u0000')
      const res = this.deps.host.publishWorkspaceChip(GIT_EXTENSION, {
        workspaceId,
        id,
        text,
        ...(id === BRANCH_CHIP ? { command: 'show' } : {}),
      })
      if (!res.ok) refused = true
    }
    for (const key of shown.keys()) {
      if (next.has(key)) continue
      const [workspaceId, id] = key.split('\u0000')
      if (cwds.has(workspaceId)) {
        this.deps.host.publishWorkspaceChip(GIT_EXTENSION, { workspaceId, id, text: '' })
      }
    }
    this.chipRefusals = refused ? this.chipRefusals + 1 : 0
    if (this.chipRefusals > 0) {
      this.schedule(nextBackoff(this.chipRefusals, CHIP_RETRY_MS, CHIP_RETRY_MAX_MS))
    }
  }
}
