import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const STACK_FILES: ReadonlyArray<readonly [string, string]> = [
  ['package.json', 'node'],
  ['Cargo.toml', 'rust'],
  ['go.mod', 'go'],
  ['pyproject.toml', 'python'],
]

export interface FolderScope {
  projectKeys: string[]
  stacks: string[]
}

export function normalizeRemote(url: string): string | null {
  const text = url.trim()
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(text)
  let host: string
  let path: string
  if (scp) {
    host = scp[1]
    path = scp[2]
  } else {
    try {
      const parsed = new URL(text)
      host = parsed.hostname
      path = parsed.pathname
    } catch {
      return null
    }
  }
  const parts = path
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)
  if (!host || parts.length < 2) return null
  return `${host.toLowerCase()}/${parts.slice(-2).join('/').toLowerCase()}`
}

async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', dir, ...args], { timeout: 5000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export async function folderScope(dir: string): Promise<FolderScope> {
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  const root = real(top ?? dir)
  const origin = top ? await git(dir, ['remote', 'get-url', 'origin']) : null
  const remote = origin ? normalizeRemote(origin) : null
  const stacks = STACK_FILES.filter(([file]) => existsSync(join(root, file))).map(
    ([, name]) => name,
  )
  return { projectKeys: remote ? [remote, root] : [root], stacks }
}

export function scopeApplies(scope: string, where: FolderScope): boolean {
  if (scope === 'global') return true
  if (scope.startsWith('stack:')) return where.stacks.includes(scope.slice(6))
  return where.projectKeys.includes(scope.slice(8))
}

export function projectScopeOf(where: FolderScope): string {
  return `project:${where.projectKeys[0]}`
}
