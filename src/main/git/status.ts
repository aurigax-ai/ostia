import type {
  BranchInfo,
  ChangeArea,
  FileChange,
  LineChanges,
  RepoStatus,
  StatusSummary,
} from '../../shared/git'
function splitFields(line: string, count: number): string[] | null {
  const fields: string[] = []
  let rest = line
  for (let i = 0; i < count - 1; i++) {
    const space = rest.indexOf(' ')
    if (space < 0) return null
    fields.push(rest.slice(0, space))
    rest = rest.slice(space + 1)
  }
  fields.push(rest)
  return fields
}

function emptyBranch(): BranchInfo {
  return { oid: null, head: null, upstream: null, ahead: 0, behind: 0 }
}

function applyHeader(branch: BranchInfo, header: string): void {
  const [key, ...restParts] = header.split(' ')
  const value = restParts.join(' ')
  if (key === 'branch.oid') branch.oid = value === '(initial)' ? null : value
  else if (key === 'branch.head') branch.head = value === '(detached)' ? null : value
  else if (key === 'branch.upstream') branch.upstream = value
  else if (key === 'branch.ab') {
    const match = /^\+(\d+) -(\d+)$/.exec(value)
    if (match) {
      branch.ahead = Number(match[1])
      branch.behind = Number(match[2])
    }
  }
}

function tracked(xy: string, path: string, origPath?: string): FileChange[] {
  const out: FileChange[] = []
  const [x, y] = [xy[0] ?? '.', xy[1] ?? '.']
  if (x !== '.') out.push({ path, area: 'staged', code: x, ...(origPath ? { origPath } : {}) })
  if (y !== '.') out.push({ path, area: 'unstaged', code: y })
  return out
}

export function parsePorcelainV2(output: string): RepoStatus {
  const branch = emptyBranch()
  const changes: FileChange[] = []
  const records = output.split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    const kind = record[0]
    if (kind === '#') {
      applyHeader(branch, record.slice(2))
    } else if (kind === '1') {
      const f = splitFields(record, 9)
      if (f) changes.push(...tracked(f[1], f[8]))
    } else if (kind === '2') {
      const f = splitFields(record, 10)
      const origPath = records[++i]
      if (f) changes.push(...tracked(f[1], f[9], origPath || undefined))
    } else if (kind === 'u') {
      const f = splitFields(record, 11)
      if (f) changes.push({ path: f[10], area: 'conflicted', code: 'U' })
    } else if (kind === '?') {
      changes.push({ path: record.slice(2), area: 'untracked', code: '?' })
    }
  }
  return { branch, changes }
}

export function summarize(status: RepoStatus): StatusSummary {
  const added = new Set<string>()
  const changed = new Set<string>()
  const summary: StatusSummary = {
    added: 0,
    changed: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
  }
  for (const c of status.changes) {
    summary[c.area] += 1
    if (c.area === 'untracked' || (c.area === 'staged' && c.code === 'A')) added.add(c.path)
  }
  for (const c of status.changes) if (!added.has(c.path)) changed.add(c.path)
  summary.added = added.size
  summary.changed = changed.size
  return summary
}

const BRANCH_MAX = 40

export function branchLabel(branch: BranchInfo): string {
  if (branch.head) {
    return branch.head.length > BRANCH_MAX
      ? `${branch.head.slice(0, BRANCH_MAX - 1)}…`
      : branch.head
  }
  return branch.oid ? `(${branch.oid.slice(0, 7)})` : '(no commits)'
}

const MAX_TRACKING_COUNT = 999

function trackingCount(n: number): string {
  return n > MAX_TRACKING_COUNT ? `${MAX_TRACKING_COUNT}+` : String(n)
}

export function branchChipText(branch: BranchInfo): string {
  const name = branch.head ?? (branch.oid ? branch.oid.slice(0, 7) : '')
  if (!name) return ''
  const tracking: string[] = []
  if (branch.upstream) {
    if (branch.ahead) tracking.push(`↑${trackingCount(branch.ahead)}`)
    if (branch.behind) tracking.push(`↓${trackingCount(branch.behind)}`)
  }
  return tracking.length ? `${name} • ${tracking.join(' ')}` : name
}

export function parseShortstat(output: string): LineChanges | null {
  const line = output.trim()
  if (!line) return null
  const files = /(\d+) files? changed/.exec(line)
  if (!files) return null
  const added = /(\d+) insertions?\(\+\)/.exec(line)
  const removed = /(\d+) deletions?\(-\)/.exec(line)
  return {
    files: Number(files[1]),
    added: added ? Number(added[1]) : 0,
    removed: removed ? Number(removed[1]) : 0,
  }
}

export function textLineCount(buf: Buffer, sniff: number): number {
  if (buf.length === 0 || buf.subarray(0, sniff).includes(0)) return 0
  let lines = 0
  for (const byte of buf) if (byte === 10) lines++
  return buf[buf.length - 1] === 10 ? lines : lines + 1
}

export function withUntracked(tracked: LineChanges | null, untrackedLines: number[]): LineChanges {
  const base = tracked ?? { files: 0, added: 0, removed: 0 }
  return {
    files: base.files + untrackedLines.length,
    added: base.added + untrackedLines.reduce((sum, n) => sum + n, 0),
    removed: base.removed,
  }
}

export function diffStatsChipText(changes: LineChanges | null): string {
  if (!changes || changes.files === 0) return ''
  const lines: string[] = []
  if (changes.added) lines.push(`+${changes.added}`)
  if (changes.removed) lines.push(`-${changes.removed}`)
  return lines.length ? `${changes.files} • ${lines.join(' ')}` : String(changes.files)
}

export type { BranchInfo, ChangeArea, FileChange, LineChanges, RepoStatus, StatusSummary }
