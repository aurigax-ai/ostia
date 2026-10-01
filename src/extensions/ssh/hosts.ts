import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

export const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/
export const MAX_INCLUDE_DEPTH = 8
export const MAX_FILES = 64
export const MAX_FILE_BYTES = 256 * 1024
export const MAX_HOSTS = 200

export interface HostList {
  hosts: string[]
  truncated: boolean
}

interface Discovery {
  home: string
  hosts: string[]
  read: Set<string>
  truncated: boolean
}

const DIRECTIVE = /^([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/
const WILDCARD = /[*?]/

function directiveArgs(rest: string): string[] {
  const args: string[] = []
  for (const token of rest.split(/\s+/).filter(Boolean)) {
    if (token.startsWith('#')) break
    args.push(token)
  }
  return args
}

function unquote(token: string): string {
  return token.length >= 2 && token.startsWith('"') && token.endsWith('"')
    ? token.slice(1, -1)
    : token
}

function segmentMatcher(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.')
  return new RegExp(`^${source}$`)
}

function includedFiles(home: string, raw: string): string[] {
  const token = unquote(raw)
  let path = token
  if (token === '~') path = home
  else if (token.startsWith('~/')) path = join(home, token.slice(2))
  else if (!isAbsolute(token)) path = join(home, '.ssh', token)
  const dir = dirname(path)
  const name = basename(path)
  if (WILDCARD.test(dir)) return []
  if (!WILDCARD.test(name)) return [path]
  const matches = segmentMatcher(name)
  try {
    return readdirSync(dir)
      .filter((entry) => !entry.startsWith('.') && matches.test(entry))
      .sort()
      .map((entry) => join(dir, entry))
  } catch {
    return []
  }
}

function readConfig(found: Discovery, file: string): string | null {
  if (found.read.size >= MAX_FILES) return null
  try {
    const real = realpathSync(file)
    if (found.read.has(real)) return null
    const stat = statSync(real)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
    found.read.add(real)
    return readFileSync(real, 'utf8')
  } catch {
    return null
  }
}

function addHost(found: Discovery, alias: string): void {
  if (!ALIAS_PATTERN.test(alias) || found.hosts.includes(alias)) return
  if (found.hosts.length >= MAX_HOSTS) {
    found.truncated = true
    return
  }
  found.hosts.push(alias)
}

function scan(found: Discovery, file: string, depth: number): void {
  const text = readConfig(found, file)
  if (text === null) return
  for (const line of text.split(/\r?\n/)) {
    if (found.truncated) return
    const directive = DIRECTIVE.exec(line.trim())
    if (!directive) continue
    const keyword = directive[1].toLowerCase()
    const args = directiveArgs(directive[2])
    if (keyword === 'host') {
      for (const alias of args) addHost(found, alias)
    } else if (keyword === 'include' && depth < MAX_INCLUDE_DEPTH) {
      for (const arg of args) {
        for (const included of includedFiles(found.home, arg)) scan(found, included, depth + 1)
      }
    }
  }
}

export function discoverHosts(home: string): HostList {
  const found: Discovery = { home, hosts: [], read: new Set(), truncated: false }
  scan(found, join(home, '.ssh', 'config'), 0)
  return { hosts: found.hosts, truncated: found.truncated }
}
