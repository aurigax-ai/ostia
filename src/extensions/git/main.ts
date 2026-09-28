import { basename, join } from 'node:path'
import {
  type CommandHandler,
  type ExtensionCaller,
  type ExtensionResult,
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
import {
  RepoError,
  diffSides,
  pickChange,
  readStatus,
  repoRelative,
  repoRoot,
  unifiedPatch,
} from './repo'
import { type ChangeArea, type RepoStatus, sidebarText, summarize } from './status'
import { WorkspaceCwds } from './workspaces'

const REFRESH_DEBOUNCE_MS = 300
const POLL_MS = 10_000
const SIDEBAR_KEY = 'branch'
const AREAS: ChangeArea[] = ['staged', 'unstaged', 'untracked', 'conflicted']

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

class GitExtension {
  private cwds = new WorkspaceCwds()
  private shown = new Map<string, string>()
  private signature = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private running = false
  private again = false
  onChanged: () => void = () => {}

  constructor(private readonly ext: PineExtension) {}

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
    if (focused && !this.poll) {
      this.poll = setInterval(() => void this.refresh(), POLL_MS)
      this.schedule(0)
    } else if (!focused && this.poll) {
      clearInterval(this.poll)
      this.poll = null
    }
  }

  async refresh(): Promise<void> {
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      await this.syncSidebar()
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

  private async syncSidebar(): Promise<void> {
    const cwds = await this.workspaceCwdMap()
    const byCwd = new Map<string, Promise<Repo | null>>()
    const next = new Map<string, string>()
    const parts: string[] = []
    for (const [workspaceId, cwd] of cwds) {
      if (!byCwd.has(cwd))
        byCwd.set(
          cwd,
          repoAt(cwd).catch(() => null),
        )
      const repo = await byCwd.get(cwd)
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

async function main(): Promise<void> {
  const ext = await connect()
  const git = new GitExtension(ext)
  const handlers = git.handlers()
  const panel = await startPanelServer({
    dir: __dirname,
    files: ['panel.html', 'panel.js', 'panel.css', 'base.css'],
    handle: async (command, args, caller) => {
      const handler = handlers[command]
      return handler ? handler(args, caller) : failure('unknown-command', command)
    },
  })
  git.onChanged = () => panel.changed()
  ext.onPanel((caller) => ({
    url: panel.url({
      workDir: caller.workDir ?? '',
      workspaceId: caller.workspaceId ?? '',
      locale: caller.locale ?? 'en',
    }),
  }))
  await ext.subscribe(
    ['cwd.changed', 'command.finished', 'pane.created', 'pane.closed', 'focus.changed'],
    (type, payload) => {
      if (type === 'focus.changed') git.setFocused((payload as { focused: boolean }).focused)
      else git.schedule()
    },
  )
  await ext.registerCommands(handlers)
  git.setFocused(true)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
