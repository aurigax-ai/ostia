export const FIELD_SEP = '\x1f'
export const RECORD_SEP = '\x1e'
export const LOG_FORMAT = `%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%at${FIELD_SEP}%s${RECORD_SEP}`

export interface CommitSummary {
  sha: string
  author: string
  email: string
  time: number
  subject: string
}

export function parseLog(output: string): CommitSummary[] {
  const commits: CommitSummary[] = []
  for (const record of output.split(RECORD_SEP)) {
    const fields = record.replace(/^\n/, '').split(FIELD_SEP)
    if (fields.length !== 5 || !/^[0-9a-f]{40,64}$/.test(fields[0])) continue
    const [sha, author, email, time, subject] = fields
    commits.push({ sha, author, email, time: Number(time), subject })
  }
  return commits
}

export const GRAPH_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s']
  .join(FIELD_SEP)
  .concat(RECORD_SEP)

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

const REF_PREFIXES: [string, RefKind][] = [
  ['refs/heads/', 'branch'],
  ['refs/remotes/', 'remote'],
  ['refs/tags/', 'tag'],
]

function parseRef(name: string, current: boolean): CommitRef | null {
  for (const [prefix, kind] of REF_PREFIXES) {
    if (!name.startsWith(prefix)) continue
    const short = name.slice(prefix.length)
    if (kind === 'remote' && short.endsWith('/HEAD')) return null
    return current ? { kind, name: short, current: true } : { kind, name: short }
  }
  return null
}

export function parseDecorations(decoration: string): CommitRef[] {
  const refs: CommitRef[] = []
  for (const raw of decoration.split(', ')) {
    const part = raw.trim()
    if (!part) continue
    if (part === 'HEAD') {
      refs.push({ kind: 'head', name: 'HEAD' })
      continue
    }
    const pointed = /^HEAD -> (.+)$/.exec(part)
    const ref = parseRef(pointed ? pointed[1] : part.replace(/^tag: /, ''), pointed !== null)
    if (ref) refs.push(ref)
  }
  const order: RefKind[] = ['head', 'branch', 'remote', 'tag']
  return refs.sort(
    (a, b) =>
      Number(b.current === true) - Number(a.current === true) ||
      order.indexOf(a.kind) - order.indexOf(b.kind),
  )
}

export function parseGraphLog(output: string): GraphCommit[] {
  const commits: GraphCommit[] = []
  for (const record of output.split(RECORD_SEP)) {
    const fields = record.replace(/^\n/, '').split(FIELD_SEP)
    if (fields.length !== 7 || !/^[0-9a-f]{40,64}$/.test(fields[0])) continue
    const [sha, parents, author, email, time, decoration, subject] = fields
    commits.push({
      sha,
      parents: parents.split(' ').filter(Boolean),
      author,
      email,
      time: Number(time),
      subject,
      refs: parseDecorations(decoration),
    })
  }
  return commits
}

export interface CommitFile {
  path: string
  origPath?: string
  code: string
}

export function parseNameStatus(output: string): CommitFile[] {
  const files: CommitFile[] = []
  const fields = output.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i]
    if (!status) continue
    const code = status[0]
    if (code === 'R' || code === 'C') {
      const origPath = fields[++i]
      const path = fields[++i]
      if (origPath && path) files.push({ path, origPath, code })
    } else {
      const path = fields[++i]
      if (path) files.push({ path, code })
    }
  }
  return files
}

export interface BlameLine {
  line: number
  sha: string
  author: string
  time: number
  summary: string
  text: string
}

const UNCOMMITTED = /^0+$/

export function isUncommitted(sha: string): boolean {
  return UNCOMMITTED.test(sha)
}

interface BlameCommit {
  author: string
  time: number
  summary: string
}

export function parseBlamePorcelain(output: string): BlameLine[] {
  const lines: BlameLine[] = []
  const commits = new Map<string, BlameCommit>()
  let sha = ''
  let final = 0
  for (const raw of output.split('\n')) {
    if (raw.startsWith('\t')) {
      const info = commits.get(sha) ?? { author: '', time: 0, summary: '' }
      lines.push({ line: final, sha, ...info, text: raw.slice(1) })
      continue
    }
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(raw)
    if (header) {
      sha = header[1]
      final = Number(header[2])
      if (!commits.has(sha)) commits.set(sha, { author: '', time: 0, summary: '' })
      continue
    }
    const info = commits.get(sha)
    if (!info) continue
    const space = raw.indexOf(' ')
    const key = space < 0 ? raw : raw.slice(0, space)
    const value = space < 0 ? '' : raw.slice(space + 1)
    if (key === 'author') info.author = value
    else if (key === 'author-time') info.time = Number(value)
    else if (key === 'summary') info.summary = value
  }
  return lines
}
