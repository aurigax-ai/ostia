import type { ExtensionSidebarItem, PaneChip, WorkspaceChip } from './extensions'

export const GIT_SOURCE = 'git'
export const PORTS_SOURCE = 'ports'
export const CORE_SOURCES: readonly string[] = [GIT_SOURCE, PORTS_SOURCE]

export const GIT_BRANCH_CHIP = 'branch'
export const GIT_DIFF_STATS_CHIP = 'diff-stats'
export const GIT_SHOW_COMMAND = 'git.show'
export const PORTS_CHIP = 'ports'
export const SSH_CHIP = 'ssh'

export interface CoreItems {
  sidebar: ExtensionSidebarItem[]
  paneChips: PaneChip[]
  workspaceChips: WorkspaceChip[]
}

export const NO_CORE_ITEMS: CoreItems = { sidebar: [], paneChips: [], workspaceChips: [] }

export function isCoreSource(id: string): boolean {
  return CORE_SOURCES.includes(id)
}

export interface BranchInfo {
  oid: string | null
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
}

export type ChangeArea = 'staged' | 'unstaged' | 'untracked' | 'conflicted'

export interface FileChange {
  path: string
  origPath?: string
  area: ChangeArea
  code: string
}

export interface RepoStatus {
  branch: BranchInfo
  changes: FileChange[]
}

export interface StatusSummary {
  added: number
  changed: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
}

export interface LineChanges {
  files: number
  added: number
  removed: number
}

export interface CommitSummary {
  sha: string
  author: string
  email: string
  time: number
  subject: string
}

export type RefKind = 'head' | 'branch' | 'remote' | 'tag'

export interface CommitRef {
  kind: RefKind
  name: string
  current?: true
}

export interface GraphCommit extends CommitSummary {
  parents: string[]
  refs: CommitRef[]
}

export interface CommitFile {
  path: string
  origPath?: string
  code: string
}

export interface BlameLine {
  line: number
  sha: string
  author: string
  time: number
  summary: string
  text: string
}

export type GraphScope = { kind: 'current' } | { kind: 'all' } | { kind: 'chosen'; refs: string[] }

export interface BranchRef {
  ref: string
  name: string
  remote: boolean
  current: boolean
  sha: string
  time: number
}

export interface ScopePlan {
  scope: GraphScope
  revisions: string[]
  includesHead: boolean
}

const UNCOMMITTED_SHA = /^0+$/

export function isUncommitted(sha: string): boolean {
  return UNCOMMITTED_SHA.test(sha)
}

export type GraphScopeSetting = 'current' | 'all'
export type ChangesView = 'list' | 'tree'

export interface GitSettings {
  enabled: boolean
  pollSeconds: number
  showDiffStats: boolean
  graphScope: GraphScopeSetting
  changesView: ChangesView
}

export const GIT_POLL_SECONDS = { min: 2, max: 3600 }

export const DEFAULT_GIT_SETTINGS: GitSettings = {
  enabled: true,
  pollSeconds: 10,
  showDiffStats: true,
  graphScope: 'current',
  changesView: 'list',
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
}

export function clampedNumber(
  raw: unknown,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.min(range.max, Math.max(range.min, raw))
}

export function parseGitSettings(raw: unknown): GitSettings {
  const r = isRecord(raw) ? raw : {}
  return {
    enabled: r.enabled !== false,
    pollSeconds: clampedNumber(r.pollSeconds, DEFAULT_GIT_SETTINGS.pollSeconds, GIT_POLL_SECONDS),
    showDiffStats: r.showDiffStats !== false,
    graphScope: r.graphScope === 'all' ? 'all' : 'current',
    changesView: r.changesView === 'tree' ? 'tree' : 'list',
  }
}

export interface GitChangesData {
  root: string
  branch: BranchInfo
  counts: StatusSummary
  changes: FileChange[]
}

export interface GitGraphData extends GitChangesData {
  branches: BranchRef[]
  scope: GraphScope
  includesHead: boolean
  commits: GraphCommit[]
  more: boolean
}

export interface GitCommitFilesData {
  root: string
  commit: CommitSummary
  parent: string | null
  files: CommitFile[]
}

export interface GitBlameData {
  root: string
  path: string
  lines: BlameLine[]
}

export type GitFailure = { ok: false; error: string; message?: string }
export type GitReply<T> = { ok: true; data: T; text?: string } | GitFailure

export interface GitPathsRequest {
  paths: string[]
  all: boolean
}

export interface GitBridge {
  watch: (workspaceIds: string[]) => void
  onItems: (cb: (items: CoreItems) => void) => () => void
  onChanged: (cb: () => void) => () => void
  changes: (workspaceId: string) => Promise<GitReply<GitChangesData>>
  graph: (workspaceId: string, limit: number) => Promise<GitReply<GitGraphData>>
  commitFiles: (workspaceId: string, sha: string) => Promise<GitReply<GitCommitFilesData>>
  blame: (workspaceId: string, file: string) => Promise<GitReply<GitBlameData>>
  openChange: (
    workspaceId: string,
    path: string,
    area: ChangeArea,
  ) => Promise<GitReply<{ opened: string; area: ChangeArea }>>
  openCommitFile: (
    workspaceId: string,
    sha: string,
    path: string,
  ) => Promise<GitReply<{ opened: string; sha: string }>>
  stage: (workspaceId: string, req: GitPathsRequest) => Promise<GitReply<{ root: string }>>
  unstage: (workspaceId: string, req: GitPathsRequest) => Promise<GitReply<{ root: string }>>
  commit: (workspaceId: string, message: string) => Promise<GitReply<{ root: string; sha: string }>>
  discard: (
    workspaceId: string,
    req: GitPathsRequest,
  ) => Promise<GitReply<{ root: string; discarded: string[] }>>
  setScope: (workspaceId: string, scope: GraphScope) => Promise<GitReply<{ scope: GraphScope }>>
}
