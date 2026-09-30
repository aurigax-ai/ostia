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
