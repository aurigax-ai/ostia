import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { ExtensionOpenDiffRequest } from '../../shared/extensions'
import {
  type BlameLine,
  type ChangeArea,
  type CommitSummary,
  type FileChange,
  GIT_SOURCE,
  type GitBlameData,
  type GitChangesData,
  type GitCommitFilesData,
  type GitGraphData,
  type GitPathsRequest,
  type GitReply,
  type GitSettings,
  type GraphScope,
  isUncommitted,
} from '../../shared/git'
import { expandHome } from '../pathGuard'
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
  log,
  pickChange,
  readStatus,
  repoRelative,
  stage,
  unifiedPatch,
  unstage,
} from './repo'
import { planScope } from './scope'
import { type Repo, repoAt } from './service'
import { summarize } from './status'
import { type GitText, listedPaths } from './text'
import type { ViewStateStore } from './viewState'

export const AREAS: readonly ChangeArea[] = ['staged', 'unstaged', 'untracked', 'conflicted']
export const DEFAULT_LOG_LIMIT = 50
export const MAX_LOG_LIMIT = 500
const GRAPH_PAGE = 300
const MAX_GRAPH_COMMITS = 10_000

export interface GitCaller {
  workspaceId?: string
  cwd?: string
  workDir?: string
}

export interface DiscardPrompt {
  title: string
  message: string
  detail: string
  confirmLabel: string
  cancelLabel: string
}

export interface GitCommandsDeps {
  settings: () => GitSettings
  text: () => GitText
  cwdOf: (workspaceId: string) => Promise<string | null>
  views: ViewStateStore
  openDiff: (req: ExtensionOpenDiffRequest) => void
  confirmDiscard: (prompt: DiscardPrompt) => Promise<boolean>
  touched: () => void
}

function failed(err: unknown): GitReply<never> {
  if (err instanceof RepoError) return { ok: false, error: err.code, message: err.message }
  return {
    ok: false,
    error: 'git-failed',
    message: err instanceof Error ? err.message : String(err),
  }
}

function invalid(message: string): GitReply<never> {
  return { ok: false, error: 'invalid-args', message }
}

export function logLimit(raw: unknown): number {
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

export function logText(commits: CommitSummary[]): string {
  return commits
    .map((c) => `${c.sha.slice(0, 7)} ${shortDate(c.time)} ${c.author}  ${c.subject}`)
    .join('\n')
}

export function blameText(lines: BlameLine[], uncommitted: string): string {
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

function discardPrompt(text: GitText, paths: string[]): DiscardPrompt {
  return {
    title: text.discardTitle,
    message:
      paths.length === 1
        ? text.discardOne
        : text.discardMany.replace('{count}', String(paths.length)),
    detail: `${listedPaths(paths, text)}\n\n${text.discardDetail}`,
    confirmLabel: text.discardConfirm,
    cancelLabel: text.cancel,
  }
}

export class GitCommands {
  constructor(private readonly deps: GitCommandsDeps) {}

  private scopeFor(root: string): GraphScope {
    const refs = this.deps.views.chosenFor(root)
    return refs ? { kind: 'chosen', refs } : { kind: this.deps.settings().graphScope }
  }

  async callerCwd(caller: GitCaller): Promise<string | null> {
    if (caller.cwd) return expandHome(caller.cwd)
    if (caller.workspaceId) {
      const cwd = await this.deps.cwdOf(caller.workspaceId).catch(() => null)
      if (cwd) return cwd
    }
    return caller.workDir ? expandHome(caller.workDir) : null
  }

  private async callerRepo(caller: GitCaller): Promise<Repo> {
    const cwd = await this.callerCwd(caller)
    if (!cwd) throw new RepoError('not-a-repo', 'no working directory is known for this caller')
    const repo = await repoAt(cwd)
    if (!repo) throw new RepoError('not-a-repo', `${cwd} is not inside a git repository`)
    return repo
  }

  private async relativePaths(repo: Repo, caller: GitCaller, paths: string[]): Promise<string[]> {
    const cwd = (await this.callerCwd(caller)) ?? repo.root
    return Promise.all(paths.map((p) => repoRelative(repo.root, cwd, p)))
  }

  private async findChange(
    repo: Repo,
    caller: GitCaller,
    input: string,
    area?: ChangeArea,
  ): Promise<FileChange> {
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

  async status(caller: GitCaller): Promise<GitReply<Omit<GitChangesData, 'changes'>>> {
    try {
      const { root, status } = await this.callerRepo(caller)
      return { ok: true, data: { root, branch: status.branch, counts: summarize(status) } }
    } catch (err) {
      return failed(err)
    }
  }

  async changes(caller: GitCaller): Promise<GitReply<GitChangesData>> {
    try {
      const { root, status } = await this.callerRepo(caller)
      return {
        ok: true,
        data: { root, branch: status.branch, counts: summarize(status), changes: status.changes },
      }
    } catch (err) {
      return failed(err)
    }
  }

  async diff(
    caller: GitCaller,
    path: string | undefined,
    area?: ChangeArea,
  ): Promise<GitReply<FileChange & { root: string; patch: string }>> {
    if (!path) return invalid('diff <path> [--staged]')
    try {
      const repo = await this.callerRepo(caller)
      const change = await this.findChange(repo, caller, path, area)
      return {
        ok: true,
        data: {
          root: repo.root,
          path: change.path,
          ...(change.origPath ? { origPath: change.origPath } : {}),
          area: change.area,
          code: change.code,
          patch: await unifiedPatch(repo.root, change),
        },
      }
    } catch (err) {
      return failed(err)
    }
  }

  async open(
    caller: GitCaller,
    path: string | undefined,
    area?: ChangeArea,
  ): Promise<GitReply<{ opened: string; area: ChangeArea }>> {
    if (!path) return invalid('open <path> [--staged]')
    try {
      const repo = await this.callerRepo(caller)
      const change = await this.findChange(repo, caller, path, area)
      const sides = await diffSides(repo.root, change)
      this.deps.openDiff({
        extId: GIT_SOURCE,
        workspaceId: caller.workspaceId,
        title: `${basename(change.path)} (${change.area})`,
        original: sides.original,
        modified: sides.modified,
        path: join(repo.root, change.path),
      })
      return { ok: true, data: { opened: change.path, area: change.area } }
    } catch (err) {
      return failed(err)
    }
  }

  async log(
    caller: GitCaller,
    limit: unknown,
    asText: boolean,
  ): Promise<GitReply<{ root: string; branch: string | null; commits: CommitSummary[] }>> {
    try {
      const repo = await this.callerRepo(caller)
      const commits = repo.status.branch.oid ? await log(repo.root, logLimit(limit)) : []
      const data = { root: repo.root, branch: repo.status.branch.head, commits }
      return asText ? { ok: true, data, text: logText(commits) } : { ok: true, data }
    } catch (err) {
      return failed(err)
    }
  }

  async blame(
    caller: GitCaller,
    input: string | undefined,
    asText: boolean,
  ): Promise<GitReply<GitBlameData>> {
    if (!input) return invalid('blame <file> [--json]')
    try {
      const cwd = (await this.callerCwd(caller)) ?? ''
      const file = isAbsolute(input) ? input : resolve(cwd, expandHome(input))
      const repo = await repoAt(dirname(file))
      if (!repo) throw new RepoError('not-a-repo', `${file} is not inside a git repository`)
      const path = await repoRelative(repo.root, repo.root, file)
      const lines = await blame(repo.root, path)
      const data = { root: repo.root, path, lines }
      if (!asText) return { ok: true, data }
      return { ok: true, data, text: blameText(lines, this.deps.text().uncommitted) }
    } catch (err) {
      return failed(err)
    }
  }

  async changeIndex(
    caller: GitCaller,
    action: 'stage' | 'unstage',
    req: GitPathsRequest,
  ): Promise<
    GitReply<{ root: string; counts: GitChangesData['counts'] } & Record<string, unknown>>
  > {
    if (!req.all && req.paths.length === 0) return invalid(this.deps.text().noPaths)
    try {
      const repo = await this.callerRepo(caller)
      const rel = req.all ? [] : await this.relativePaths(repo, caller, req.paths)
      if (action === 'stage') await stage(repo.root, rel)
      else await unstage(repo.root, rel, repo.status.branch.oid !== null)
      this.deps.touched()
      const counts = summarize(await readStatus(repo.root))
      return {
        ok: true,
        data: {
          root: repo.root,
          [action === 'stage' ? 'staged' : 'unstaged']: req.all ? 'all' : rel,
          counts,
        },
      }
    } catch (err) {
      return failed(err)
    }
  }

  async commit(
    caller: GitCaller,
    message: unknown,
  ): Promise<GitReply<{ root: string; sha: string; subject: string }>> {
    const text = typeof message === 'string' ? message.trim() : ''
    if (!text) return invalid(this.deps.text().emptyMessage)
    try {
      const repo = await this.callerRepo(caller)
      const sha = await commit(repo.root, text)
      this.deps.touched()
      return { ok: true, data: { root: repo.root, sha, subject: text.split('\n')[0] }, text: sha }
    } catch (err) {
      return failed(err)
    }
  }

  async graph(caller: GitCaller, limit: unknown): Promise<GitReply<GitGraphData>> {
    const max = graphLimit(limit)
    try {
      const { root, status } = await this.callerRepo(caller)
      const branches = await branchRefs(root, status.branch.head)
      const plan = planScope(this.scopeFor(root), branches)
      const commits = status.branch.oid ? await graphLog(root, plan.revisions, max + 1) : []
      return {
        ok: true,
        data: {
          root,
          branch: status.branch,
          counts: summarize(status),
          changes: status.changes,
          branches,
          scope: plan.scope,
          includesHead: plan.includesHead,
          commits: commits.slice(0, max),
          more: commits.length > max,
        },
      }
    } catch (err) {
      return failed(err)
    }
  }

  async setScope(caller: GitCaller, scope: GraphScope): Promise<GitReply<{ scope: GraphScope }>> {
    try {
      const { root } = await this.callerRepo(caller)
      this.deps.views.setChosen(root, scope.kind === 'chosen' ? scope.refs : null)
      return { ok: true, data: { scope } }
    } catch (err) {
      return failed(err)
    }
  }

  async discard(
    caller: GitCaller,
    req: GitPathsRequest,
  ): Promise<GitReply<{ root: string; discarded: string[] }>> {
    const text = this.deps.text()
    try {
      const repo = await this.callerRepo(caller)
      const wanted = req.all ? null : await this.relativePaths(repo, caller, req.paths)
      const targets = repo.status.changes.filter(
        (c) =>
          (c.area === 'unstaged' || c.area === 'untracked') &&
          (wanted === null || wanted.includes(c.path)),
      )
      if (targets.length === 0) {
        return { ok: false, error: 'not-changed', message: text.nothingToDiscard }
      }
      const listed = [...new Set(targets.map((c) => c.path))]
      const confirmed = await this.deps.confirmDiscard(discardPrompt(text, listed))
      if (!confirmed) return { ok: false, error: 'cancelled', message: text.discardCancelled }
      await discard(repo.root, targets)
      this.deps.touched()
      return { ok: true, data: { root: repo.root, discarded: listed } }
    } catch (err) {
      return failed(err)
    }
  }

  async commitFiles(caller: GitCaller, sha: unknown): Promise<GitReply<GitCommitFilesData>> {
    if (typeof sha !== 'string') return invalid('sha')
    try {
      const repo = await this.callerRepo(caller)
      const detail = await commitDetail(repo.root, sha)
      return { ok: true, data: { root: repo.root, ...detail } }
    } catch (err) {
      return failed(err)
    }
  }

  async openCommitFile(
    caller: GitCaller,
    sha: unknown,
    path: unknown,
  ): Promise<GitReply<{ opened: string; sha: string }>> {
    if (typeof sha !== 'string' || typeof path !== 'string') return invalid('sha, path')
    try {
      const repo = await this.callerRepo(caller)
      const detail = await commitDetail(repo.root, sha)
      const file = detail.files.find((f) => f.path === path)
      if (!file) throw new RepoError('not-changed', `${path} is not changed in ${sha}`)
      const sides = await commitSides(repo.root, detail, file)
      this.deps.openDiff({
        extId: GIT_SOURCE,
        workspaceId: caller.workspaceId,
        title: `${basename(file.path)} (${detail.commit.sha.slice(0, 7)})`,
        original: sides.original,
        modified: sides.modified,
        path: join(repo.root, file.path),
      })
      return { ok: true, data: { opened: file.path, sha: detail.commit.sha } }
    } catch (err) {
      return failed(err)
    }
  }
}
