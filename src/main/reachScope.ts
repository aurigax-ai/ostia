import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { ReachMode } from '../shared/reach'
import { type WorkspaceSandbox, sandboxMergeRefusal } from '../shared/sandbox'

export interface ScopeGroup {
  id: string
  byAgent: boolean
}

export interface ScopeWorkspace {
  id: string
  shareable: boolean
  project: string | null
  sandbox: WorkspaceSandbox
  group: ScopeGroup | null
}

function sameGroup(a: ScopeWorkspace, b: ScopeWorkspace): boolean {
  return a.group !== null && b.group !== null && a.group.id === b.group.id
}

export function sameReachScope(
  caller: ScopeWorkspace,
  target: ScopeWorkspace,
  mode: ReachMode,
): boolean {
  if (!caller.id || !target.id) return false
  if (caller.id === target.id) return true
  if (mode === 'workspace') return false
  if (!caller.shareable || !target.shareable) return false
  if (caller.sandbox.enabled) return false
  if (sandboxMergeRefusal(caller.sandbox, target.sandbox) !== null) return false
  if (mode === 'project') return caller.project !== null && caller.project === target.project
  return sameGroup(caller, target) && !caller.group?.byAgent && !target.group?.byAgent
}

export function unconfirmedGroupMembers(
  caller: ScopeWorkspace,
  target: ScopeWorkspace,
  mode: ReachMode,
): string[] {
  if (mode !== 'group' || !sameGroup(caller, target)) return []
  const confirmed = (w: ScopeWorkspace): ScopeWorkspace =>
    w.group ? { ...w, group: { ...w.group, byAgent: false } } : w
  if (!sameReachScope(confirmed(caller), confirmed(target), mode)) return []
  return [caller, target].filter((w) => w.group?.byAgent).map((w) => w.id)
}

function realOr(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`)
}

function commonGitDir(dotGit: string): string | null {
  try {
    if (statSync(dotGit).isDirectory()) return realOr(dotGit)
    const line = readFileSync(dotGit, 'utf8').trim()
    if (!line.startsWith('gitdir:')) return null
    const raw = line.slice('gitdir:'.length).trim()
    const gitDir = isAbsolute(raw) ? raw : resolve(dirname(dotGit), raw)
    try {
      const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
      return realOr(isAbsolute(common) ? common : resolve(gitDir, common))
    } catch {
      return realOr(gitDir)
    }
  } catch {
    return null
  }
}

export function projectKey(workDir: string, home: string): string | null {
  const expanded =
    workDir === '~' || workDir.startsWith('~/') ? join(home, workDir.slice(1)) : workDir
  if (!isAbsolute(expanded)) return null
  const dir = realOr(resolve(expanded))
  const realHome = realOr(home)
  if (within(realHome, dir)) return null
  let at = dir
  while (at !== realHome && dirname(at) !== at) {
    const common = commonGitDir(join(at, '.git'))
    if (common) return `git:${common}`
    at = dirname(at)
  }
  return `dir:${dir}`
}

export class GroupProvenance {
  private readonly placed = new Map<string, string>()

  placedByAgent(workspaceId: string, groupId: string): void {
    this.placed.set(workspaceId, groupId)
  }

  byAgent(workspaceId: string, groupId: string): boolean {
    return this.placed.get(workspaceId) === groupId
  }

  confirm(workspaceId: string): void {
    this.placed.delete(workspaceId)
  }

  forget(workspaceId: string): void {
    this.placed.delete(workspaceId)
  }
}
