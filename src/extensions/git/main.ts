import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  type CommandHandler,
  type ExtensionCaller,
  type ExtensionResult,
  type ExtensionSettingValues,
  type PaneInfo,
  type PineExtension,
  cliArgs,
  connect,
  expandHome,
  failure,
  namedArgs,
  ok,
  parseFlags,
  startPanelServer,
} from '../sdk'
import { type BlameLine, type CommitSummary, isUncommitted } from './history'
import {
  RepoError,
  blame,
  branchRefs,
  commit,
  commitDetail,
  commitSides,
  diffSides,
  discard,
  graphLog,
  lineChanges,
  log,
  pickChange,
  readStatus,
  repoRelative,
  repoRoot,
  stage,
  unifiedPatch,
  unstage,
} from './repo'
import { type GraphScope, parseScope, planScope } from './scope'
import { type GitSettings, readGitSettings } from './settings'
import {
  type ChangeArea,
  type RepoStatus,
  branchChipText,
  diffStatsChipText,
  sidebarText,
  summarize,
} from './status'
import { stringsFor } from './strings'
import { ViewStateStore } from './viewState'
import { WorkspaceCwds } from './workspaces'

const REFRESH_DEBOUNCE_MS = 300
const SIDEBAR_KEY = 'branch'
const BRANCH_CHIP = 'branch'
const DIFF_STATS_CHIP = 'diff-stats'
const AREAS: ChangeArea[] = ['staged', 'unstaged', 'untracked', 'conflicted']
const DEFAULT_LOG_LIMIT = 50
const MAX_LOG_LIMIT = 500
const GRAPH_PANEL_PATH = '/graph'
const GRAPH_PAGE = 300
const MAX_GRAPH_COMMITS = 10_000
const VIEW_STATE_FILE = 'view.json'

interface Repo {
  root: string
  status: RepoStatus
}

async function repoAt(cwd: string): Promise<Repo | null> {
  const root = await repoRoot(cwd)
  if (!root) return null
  return { root, status: await readStatus(root) }
}

function errorResult(err: unknown): ExtensionResult {
  if (err instanceof RepoError) return failure(err.code, err.message)
  return failure('git-failed', err instanceof Error ? err.message : String(err))
}

function targetArgs(args: unknown): { path?: string; area?: ChangeArea } {
  const cli = cliArgs(args)
  if (cli) {
    const { bools, rest } = parseFlags(cli.argv, [], ['staged'])
    return { path: rest[0], area: bools.has('staged') ? 'staged' : undefined }
  }
  const named = namedArgs(args)
  const area = AREAS.find((a) => a === named.area)
  return { path: typeof named.path === 'string' ? named.path : undefined, area }
}

function pathsArgs(args: unknown): { paths: string[]; all: boolean } {
  const cli = cliArgs(args)
  if (cli) {
    const { bools, rest } = parseFlags(cli.argv, [], ['all'])
    return { paths: rest, all: bools.has('all') }
  }
  const named = namedArgs(args)
  const paths = Array.isArray(named.paths)
    ? named.paths.filter((p): p is string => typeof p === 'string')
    : []
  return { paths, all: named.all === true }
}

function logLimit(raw: string | number | undefined): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LOG_LIMIT
  return Math.min(n, MAX_LOG_LIMIT)
}

function graphLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isInteger(n) || n < 1) return GRAPH_PAGE
  return Math.min(n, MAX_GRAPH_COMMITS)
}

function shortDate(time: number): string {
  return new Date(time * 1000).toISOString().slice(0, 10)
}

function logText(commits: CommitSummary[]): string {
  return commits
    .map((c) => `${c.sha.slice(0, 7)} ${shortDate(c.time)} ${c.author}  ${c.subject}`)
    .join('\n')
}

function blameText(lines: BlameLine[], uncommitted: string): string {
  const width = String(lines.length).length
  return lines
    .map((l) => {
      const who = isUncommitted(l.sha)
        ? uncommitted
        : `${l.sha.slice(0, 8)} ${shortDate(l.time)} ${l.author}`
      return `${String(l.line).padStart(width)} ${who}\t${l.text}`
    })
    .join('\n')
}

function blamePanelPath(file: string): string {
  return `/blame?file=${encodeURIComponent(file)}`
}

class GitExtension {
  private cwds = new WorkspaceCwds()
  private shown = new Map<string, string>()
  private chips = new Map<string, string>()
  private signature = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private focused = true
  private running = false
  private again = false
  private settings: GitSettings = readGitSettings({})
  private views = new ViewStateStore(
    process.env.PINE_EXTENSION_DATA ? join(process.env.PINE_EXTENSION_DATA, VIEW_STATE_FILE) : null,
  )
  onChanged: () => void = () => {}

  constructor(private readonly ext: PineExtension) {}

  applySettings(values: ExtensionSettingValues): void {
    this.settings = readGitSettings(values)
    this.restartPoll()
    this.schedule(0)
    this.onChanged()
  }

  private scopeFor(root: string): GraphScope {
    const refs = this.views.chosenFor(root)
    return refs ? { kind: 'chosen', refs } : { kind: this.settings.graphScope }
  }

  private storeSetting(key: string, value: string): Promise<ExtensionResult> {
    return this.ext.setSetting(key, value)
  }

  async workspaceCwdMap(): Promise<Map<string, string>> {
    const [workspaces, panes] = await Promise.all([this.ext.listWorkspaces(), this.ext.listPanes()])
    return this.cwds.resolve(workspaces, panes)
  }

  async callerCwd(caller: ExtensionCaller): Promise<string | null> {
    if (caller.cwd) return expandHome(caller.cwd)
    if (caller.workspaceId) {
      const cwd = (await this.workspaceCwdMap().catch(() => null))?.get(caller.workspaceId)
      if (cwd) return cwd
    }
    return caller.workDir ? expandHome(caller.workDir) : null
  }

  async callerRepo(caller: ExtensionCaller): Promise<Repo> {
    const cwd = await this.callerCwd(caller)
    if (!cwd) throw new RepoError('not-a-repo', 'no working directory is known for this caller')
    const repo = await repoAt(cwd)
    if (!repo) throw new RepoError('not-a-repo', `${cwd} is not inside a git repository`)
    return repo
  }

  schedule(delay = REFRESH_DEBOUNCE_MS): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, delay)
  }

  setFocused(focused: boolean): void {
    this.focused = focused
    this.restartPoll()
    if (focused) this.schedule(0)
  }

  private restartPoll(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = this.focused ? setInterval(() => void this.refresh(), this.settings.pollMs) : null
  }

  async refresh(): Promise<void> {
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      const [workspaces, panes] = await Promise.all([
        this.ext.listWorkspaces(),
        this.ext.listPanes(),
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
      await this.syncSidebar(this.cwds.resolve(workspaces, panes), repoFor)
      await this.syncChips(panes, repoFor)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
    } finally {
      this.running = false
      if (this.again) {
        this.again = false
        this.schedule()
      }
    }
  }

  private async syncSidebar(
    cwds: Map<string, string>,
    repoFor: (cwd: string) => Promise<Repo | null>,
  ): Promise<void> {
    const next = new Map<string, string>()
    const parts: string[] = []
    for (const [workspaceId, cwd] of cwds) {
      const repo = await repoFor(cwd)
      if (!repo) continue
      next.set(workspaceId, sidebarText(repo.status))
      parts.push(`${workspaceId}\u0000${repo.root}\u0000${JSON.stringify(repo.status)}`)
    }
    for (const [workspaceId, text] of next) {
      if (this.shown.get(workspaceId) === text) continue
      await this.ext.setSidebarItem({ workspaceId, key: SIDEBAR_KEY, text, icon: 'git-branch' })
    }
    for (const workspaceId of this.shown.keys()) {
      if (!next.has(workspaceId)) {
        await this.ext.setSidebarItem({ workspaceId, key: SIDEBAR_KEY, text: '' })
      }
    }
    this.shown = next
    const signature = parts.sort().join('\n')
    if (signature !== this.signature) {
      this.signature = signature
      this.onChanged()
    }
  }

  private async syncChips(
    panes: PaneInfo[],
    repoFor: (cwd: string) => Promise<Repo | null>,
  ): Promise<void> {
    const stats = new Map<string, Promise<string>>()
    const statsFor = (root: string): Promise<string> => {
      let found = stats.get(root)
      if (!found) {
        found = lineChanges(root)
          .then(diffStatsChipText)
          .catch(() => '')
        stats.set(root, found)
      }
      return found
    }
    const next = new Map<string, string>()
    for (const pane of panes) {
      if (pane.kind !== 'terminal' || !pane.cwd) continue
      const repo = await repoFor(expandHome(pane.cwd))
      if (!repo) continue
      const branch = branchChipText(repo.status.branch)
      if (branch) next.set(`${pane.paneId}\u0000${BRANCH_CHIP}`, branch)
      if (this.settings.showDiffStats) {
        const diff = await statsFor(repo.root)
        if (diff) next.set(`${pane.paneId}\u0000${DIFF_STATS_CHIP}`, diff)
      }
    }
    const live = new Set(panes.map((p) => p.paneId))
    for (const [key, text] of next) {
      if (this.chips.get(key) === text) continue
      const [paneId, id] = key.split('\u0000')
      await this.ext.setPaneChip({
        paneId,
        id,
        text,
        ...(id === BRANCH_CHIP ? { command: 'show' } : {}),
      })
    }
    for (const key of this.chips.keys()) {
      if (next.has(key)) continue
      const [paneId, id] = key.split('\u0000')
      if (live.has(paneId)) await this.ext.clearPaneChip(paneId, id)
    }
    this.chips = next
  }

  private changed(): void {
    this.onChanged()
    this.schedule(0)
  }

  handlers(): Record<string, CommandHandler> {
    return {
      status: async (_args, caller) => {
        try {
          const { root, status } = await this.callerRepo(caller)
          return ok(undefined, { root, branch: status.branch, counts: summarize(status) })
        } catch (err) {
          return errorResult(err)
        }
      },
      changes: async (_args, caller) => {
        try {
          const { root, status } = await this.callerRepo(caller)
          return ok(undefined, {
            root,
            branch: status.branch,
            counts: summarize(status),
            changes: status.changes,
          })
        } catch (err) {
          return errorResult(err)
        }
      },
      diff: async (args, caller) => {
        const target = targetArgs(args)
        if (!target.path) return failure('invalid-args', 'diff <path> [--staged]')
        try {
          const repo = await this.callerRepo(caller)
          const change = await this.findChange(repo, caller, target.path, target.area)
          return ok(undefined, {
            root: repo.root,
            path: change.path,
            ...(change.origPath ? { origPath: change.origPath } : {}),
            area: change.area,
            code: change.code,
            patch: await unifiedPatch(repo.root, change),
          })
        } catch (err) {
          return errorResult(err)
        }
      },
      open: async (args, caller) => {
        const target = targetArgs(args)
        if (!target.path) return failure('invalid-args', 'open <path> [--staged]')
        try {
          const repo = await this.callerRepo(caller)
          const change = await this.findChange(repo, caller, target.path, target.area)
          const sides = await diffSides(repo.root, change)
          const res = await this.ext.openDiff({
            workspaceId: caller.workspaceId,
            title: `${basename(change.path)} (${change.area})`,
            original: sides.original,
            modified: sides.modified,
            path: join(repo.root, change.path),
          })
          if (!res.ok) return res
          return ok(undefined, { opened: change.path, area: change.area })
        } catch (err) {
          return errorResult(err)
        }
      },
      show: async (_args, caller) => {
        await this.ext.openPanel(caller.workspaceId)
        return ok('ok')
      },
      'show-graph': async (_args, caller) => {
        await this.ext.openPanel(caller.workspaceId, GRAPH_PANEL_PATH)
        return ok('ok')
      },
      'blame-file': async (_args, caller) => {
        const panes = await this.ext.listPanes()
        const pane = panes.find((p) => p.paneId === caller.paneId)
        if (pane?.kind !== 'editor' || !pane.filePath) {
          return failure('no-file', stringsFor(caller.locale).noFile)
        }
        await this.ext.openPanel(caller.workspaceId, blamePanelPath(pane.filePath))
        return ok('ok')
      },
      log: async (args, caller) => {
        const cli = cliArgs(args)
        const parsed = cli ? parseFlags(cli.argv, ['limit'], ['json']) : null
        const named = namedArgs(args)
        const limit = logLimit(parsed ? parsed.flags.limit : (named.limit as number | undefined))
        try {
          const repo = await this.callerRepo(caller)
          const commits = repo.status.branch.oid ? await log(repo.root, limit) : []
          const data = { root: repo.root, branch: repo.status.branch.head, commits }
          if (parsed && !parsed.bools.has('json')) return ok(logText(commits), data)
          return ok(undefined, data)
        } catch (err) {
          return errorResult(err)
        }
      },
      blame: async (args, caller) => {
        const cli = cliArgs(args)
        const parsed = cli ? parseFlags(cli.argv, [], ['json']) : null
        const named = namedArgs(args)
        const input = parsed ? parsed.rest[0] : typeof named.path === 'string' ? named.path : ''
        if (!input) return failure('invalid-args', 'blame <file> [--json]')
        try {
          const cwd = (await this.callerCwd(caller)) ?? ''
          const file = isAbsolute(input) ? input : resolve(cwd, expandHome(input))
          const repo = await repoAt(dirname(file))
          if (!repo) throw new RepoError('not-a-repo', `${file} is not inside a git repository`)
          const path = await repoRelative(repo.root, repo.root, file)
          const lines = await blame(repo.root, path)
          const data = { root: repo.root, path, lines }
          if (parsed && !parsed.bools.has('json')) {
            return ok(blameText(lines, stringsFor(caller.locale).uncommitted), data)
          }
          return ok(undefined, data)
        } catch (err) {
          return errorResult(err)
        }
      },
      stage: async (args, caller) => this.changeIndex(args, caller, 'stage'),
      unstage: async (args, caller) => this.changeIndex(args, caller, 'unstage'),
      commit: async (args, caller) => {
        const text = commitMessage(args)
        if (!text) return failure('invalid-args', stringsFor(caller.locale).emptyMessage)
        try {
          const repo = await this.callerRepo(caller)
          const sha = await commit(repo.root, text)
          this.changed()
          return ok(sha, { root: repo.root, sha, subject: text.split('\n')[0] })
        } catch (err) {
          return errorResult(err)
        }
      },
    }
  }

  panelHandlers(): Record<string, CommandHandler> {
    return {
      view: async () => ok(undefined, { changesView: this.settings.changesView }),
      setChangesView: async (args) => {
        const view = namedArgs(args).view
        if (view !== 'list' && view !== 'tree') return failure('invalid-args', 'view: list | tree')
        const res = await this.storeSetting('changesView', view)
        return res.ok ? ok(undefined, { changesView: view }) : res
      },
      graph: async (args, caller) => {
        const limit = graphLimit(namedArgs(args).limit)
        try {
          const { root, status } = await this.callerRepo(caller)
          const branches = await branchRefs(root, status.branch.head)
          const plan = planScope(this.scopeFor(root), branches)
          const commits = status.branch.oid ? await graphLog(root, plan.revisions, limit + 1) : []
          return ok(undefined, {
            root,
            branch: status.branch,
            counts: summarize(status),
            changes: status.changes,
            branches,
            scope: plan.scope,
            includesHead: plan.includesHead,
            commits: commits.slice(0, limit),
            more: commits.length > limit,
          })
        } catch (err) {
          return errorResult(err)
        }
      },
      setScope: async (args, caller) => {
        const scope = parseScope(namedArgs(args).scope)
        if (!scope) return failure('invalid-args', 'scope')
        try {
          const { root } = await this.callerRepo(caller)
          if (scope.kind === 'chosen') {
            this.views.setChosen(root, scope.refs)
            return ok(undefined, { root, scope })
          }
          this.views.setChosen(root, null)
          const res = await this.storeSetting('graphScope', scope.kind)
          return res.ok ? ok(undefined, { root, scope }) : res
        } catch (err) {
          return errorResult(err)
        }
      },
      discard: async (args, caller) => {
        const s = stringsFor(caller.locale)
        const { paths, all } = pathsArgs(args)
        try {
          const repo = await this.callerRepo(caller)
          const wanted = all ? null : await this.relativePaths(repo, caller, paths)
          const targets = repo.status.changes.filter(
            (c) =>
              (c.area === 'unstaged' || c.area === 'untracked') &&
              (wanted === null || wanted.includes(c.path)),
          )
          if (targets.length === 0) return failure('not-changed', s.nothingToDiscard)
          const listed = [...new Set(targets.map((c) => c.path))]
          const confirmed = await this.ext.confirm({
            title: s.discardTitle,
            message: s.discardMessage(listed.length),
            detail: s.discardDetail(listed),
            confirmLabel: s.discardConfirm,
            cancelLabel: s.cancel,
          })
          if (!confirmed) return failure('cancelled', s.cancelled)
          await discard(repo.root, targets)
          this.changed()
          return ok(undefined, { root: repo.root, discarded: listed })
        } catch (err) {
          return errorResult(err)
        }
      },
      commitFiles: async (args, caller) => {
        const sha = namedArgs(args).sha
        if (typeof sha !== 'string') return failure('invalid-args', 'sha')
        try {
          const repo = await this.callerRepo(caller)
          const detail = await commitDetail(repo.root, sha)
          return ok(undefined, { root: repo.root, ...detail })
        } catch (err) {
          return errorResult(err)
        }
      },
      openCommitFile: async (args, caller) => {
        const { sha, path } = namedArgs(args)
        if (typeof sha !== 'string' || typeof path !== 'string') {
          return failure('invalid-args', 'sha, path')
        }
        try {
          const repo = await this.callerRepo(caller)
          const detail = await commitDetail(repo.root, sha)
          const file = detail.files.find((f) => f.path === path)
          if (!file) throw new RepoError('not-changed', `${path} is not changed in ${sha}`)
          const sides = await commitSides(repo.root, detail, file)
          const res = await this.ext.openDiff({
            workspaceId: caller.workspaceId,
            title: `${basename(file.path)} (${detail.commit.sha.slice(0, 7)})`,
            original: sides.original,
            modified: sides.modified,
            path: join(repo.root, file.path),
          })
          if (!res.ok) return res
          return ok(undefined, { opened: file.path, sha: detail.commit.sha })
        } catch (err) {
          return errorResult(err)
        }
      },
    }
  }

  private async relativePaths(
    repo: Repo,
    caller: ExtensionCaller,
    paths: string[],
  ): Promise<string[]> {
    const cwd = (await this.callerCwd(caller)) ?? repo.root
    return Promise.all(paths.map((p) => repoRelative(repo.root, cwd, p)))
  }

  private async changeIndex(
    args: unknown,
    caller: ExtensionCaller,
    action: 'stage' | 'unstage',
  ): Promise<ExtensionResult> {
    const { paths, all } = pathsArgs(args)
    if (!all && paths.length === 0) {
      return failure('invalid-args', stringsFor(caller.locale).noPaths)
    }
    try {
      const repo = await this.callerRepo(caller)
      const rel = all ? [] : await this.relativePaths(repo, caller, paths)
      if (action === 'stage') await stage(repo.root, rel)
      else await unstage(repo.root, rel, repo.status.branch.oid !== null)
      this.changed()
      const counts = summarize(await readStatus(repo.root))
      return ok(undefined, {
        root: repo.root,
        [action === 'stage' ? 'staged' : 'unstaged']: all ? 'all' : rel,
        counts,
      })
    } catch (err) {
      return errorResult(err)
    }
  }

  private async findChange(repo: Repo, caller: ExtensionCaller, input: string, area?: ChangeArea) {
    const cwd = (await this.callerCwd(caller)) ?? repo.root
    const rel = await repoRelative(repo.root, cwd, input).catch(() => null)
    const change =
      (rel ? pickChange(repo.status.changes, rel, area) : null) ??
      pickChange(repo.status.changes, input.replace(/^\.\//, ''), area)
    if (!change) {
      throw new RepoError('not-changed', `${input} has no ${area ? `${area} ` : ''}changes`)
    }
    return change
  }
}

function commitMessage(args: unknown): string {
  const cli = cliArgs(args)
  if (!cli) {
    const message = namedArgs(args).message
    return typeof message === 'string' ? message.trim() : ''
  }
  const parts: string[] = []
  cli.argv.forEach((arg, i) => {
    if ((arg === '-m' || arg === '--message') && i + 1 < cli.argv.length) {
      parts.push(cli.argv[i + 1])
    }
  })
  return parts.join('\n\n').trim()
}

async function main(): Promise<void> {
  const ext = await connect()
  const git = new GitExtension(ext)
  const handlers = git.handlers()
  const panelOnly = git.panelHandlers()
  const panel = await startPanelServer({
    dir: __dirname,
    files: ['panel.html', 'panel.js', 'panel.css', 'base.css'],
    handle: async (command, args, caller) => {
      const handler = handlers[command] ?? panelOnly[command]
      return handler ? handler(args, caller) : failure('unknown-command', command)
    },
  })
  git.onChanged = () => panel.changed()
  ext.onPanel((caller, path) => {
    const url = new URL(path ?? '/', 'http://panel')
    const query: Record<string, string> = {
      workDir: caller.workDir ?? '',
      workspaceId: caller.workspaceId ?? '',
      locale: caller.locale ?? 'en',
      page:
        url.pathname === GRAPH_PANEL_PATH
          ? 'graph'
          : url.pathname === '/blame'
            ? 'blame'
            : 'changes',
    }
    const file = url.searchParams.get('file')
    if (query.page === 'blame' && file) query.file = file
    return { url: panel.url(query) }
  })
  ext.onSettingsChanged((values) => git.applySettings(values))
  await ext.subscribe(
    ['cwd.changed', 'command.finished', 'pane.created', 'pane.closed', 'focus.changed'],
    (type, payload) => {
      if (type === 'focus.changed') git.setFocused((payload as { focused: boolean }).focused)
      else git.schedule()
    },
  )
  await ext.registerCommands(handlers)
  git.applySettings(await ext.getSettings())
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
