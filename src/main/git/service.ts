import type {
  ExtensionSidebarItem,
  WorkspaceChip,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { GIT_SOURCE } from '@aurigax-ai/ostia-extension-sdk/manifest/coreNames'
import {
  type CoreItems,
  GIT_BRANCH_CHIP,
  GIT_SHOW_COMMAND,
  type GitSettings,
  type RepoStatus,
} from '../../shared/boards/git'
import type { PaneEntry, WorkspaceEntry } from '../panes/paneList'
import { WatchedRefresher } from '../platform/watchedRefresher'
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
  const branch = branchChipText(shown.repo.status.branch, shown.diffStats)
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
  return { sidebar, paneChips: [], workspaceChips }
}

export class GitService extends WatchedRefresher<Map<string, Shown>> {
  private cwds = new WorkspaceCwds()
  private settings: GitSettings
  private signature = ''

  constructor(private readonly deps: GitServiceDeps) {
    super({
      channel: GIT_ITEMS_CHANNEL,
      debounceMs: REFRESH_DEBOUNCE_MS,
      events: REFRESH_EVENTS,
      send: deps.send,
      log: deps.log,
    })
    this.settings = deps.settings()
  }

  protected enabled(): boolean {
    return this.settings.enabled
  }

  protected pollMs(): number {
    return this.settings.pollSeconds * 1000
  }

  settingsChanged(): void {
    this.settings = this.deps.settings()
    this.apply()
    this.announceChange()
  }

  shown(): void {
    if (this.active) this.schedule(0)
  }

  touched(): void {
    this.announceChange()
    if (this.active) this.schedule(0)
  }

  async cwdOf(workspaceId: string): Promise<string | null> {
    const [workspaces, panes] = await Promise.all([
      this.deps.listWorkspaces(),
      this.deps.listPanes(),
    ])
    return this.cwds.resolve(workspaces, panes).get(workspaceId) ?? null
  }

  private announceChange(): void {
    for (const [windowId] of this.watches.windows()) {
      this.deps.send(windowId, GIT_CHANGED_CHANNEL, null)
    }
  }

  protected async read(watched: ReadonlySet<string>): Promise<Map<string, Shown>> {
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

  protected cleared(): void {
    this.signature = ''
  }

  protected itemsFor(ids: ReadonlySet<string>, shown: Map<string, Shown>): CoreItems {
    const items: CoreItems = { sidebar: [], paneChips: [], workspaceChips: [] }
    for (const workspaceId of ids) {
      const one = shown.get(workspaceId)
      if (!one) continue
      const own = itemsFor(workspaceId, one)
      items.sidebar.push(...own.sidebar)
      items.workspaceChips.push(...own.workspaceChips)
    }
    return items
  }

  protected published(shown: Map<string, Shown>): void {
    const signature = [...shown]
      .map(([workspaceId, one]) => `${workspaceId}\u0000${JSON.stringify(one.repo)}`)
      .sort()
      .join('\n')
    if (signature === this.signature) return
    this.signature = signature
    this.announceChange()
  }
}
