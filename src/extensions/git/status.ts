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

export function sidebarText(status: RepoStatus): string {
  const s = summarize(status)
  const parts = [branchLabel(status.branch)]
  if (status.branch.upstream) {
    if (status.branch.ahead) parts.push(`↑${status.branch.ahead}`)
    if (status.branch.behind) parts.push(`↓${status.branch.behind}`)
  }
  if (s.added) parts.push(`+${s.added}`)
  if (s.changed) parts.push(`~${s.changed}`)
  return parts.join(' ')
}
