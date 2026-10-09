export interface FileLinkMatch {
  start: number
  end: number
  path: string
  line?: number
  column?: number
}

const PATH_CHARS = String.raw`[\w.@+\-~/]`
const PATH = String.raw`(?:~\/|\.{1,2}\/|\/)?(?:${PATH_CHARS}+\/)*${PATH_CHARS}*[\w@+\-]`
const QUOTED = String.raw`"(?<qpath>${PATH})", line (?<qline>\d+)`
const PLAIN = String.raw`(?<path>${PATH})(?::(?<line>\d+)(?::(?<col>\d+))?|\((?<pline>\d+)(?:,\s?(?<pcol>\d+))?\))?`
const PATTERN = new RegExp(`${QUOTED}|${PLAIN}`, 'g')

function looksLikePath(path: string): boolean {
  if (path.includes('/')) return /[\w@+\-]/.test(path.replace(/[~./]/g, ''))
  return /\.[A-Za-z][\w-]{0,9}$/.test(path) && !/^\d/.test(path) && !path.includes('@')
}

function isUrlContext(text: string, start: number): boolean {
  return (
    /[A-Za-z][\w+.-]*:\/\/\S*$/.test(text.slice(0, start)) || text.slice(start).startsWith('//')
  )
}

const positive = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined
  const n = Number(v)
  return n > 0 ? n : undefined
}

export function findFileLinks(text: string): FileLinkMatch[] {
  const out: FileLinkMatch[] = []
  for (const m of text.matchAll(PATTERN)) {
    const groups = m.groups ?? {}
    const start = m.index ?? 0
    const prev = start > 0 ? text[start - 1] : ''
    if (groups.qpath) {
      out.push({
        start: start + 1,
        end: start + 1 + groups.qpath.length,
        path: groups.qpath,
        line: positive(groups.qline),
      })
      continue
    }
    const path = groups.path
    if (!path || /[\w@]/.test(prev) || !looksLikePath(path) || isUrlContext(text, start)) continue
    out.push({
      start,
      end: start + m[0].length,
      path,
      line: positive(groups.line ?? groups.pline),
      column: positive(groups.col ?? groups.pcol),
    })
  }
  return out
}

function normalize(path: string): string {
  const home = path === '~' || path.startsWith('~/')
  const parts: string[] = []
  for (const part of (home ? path.slice(1) : path).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${home ? '~' : ''}/${parts.join('/')}`
}

export function resolveLinkPath(path: string, cwd: string): string {
  if (path.startsWith('~/') || path.startsWith('/')) return normalize(path)
  return normalize(`${cwd}/${path}`)
}
