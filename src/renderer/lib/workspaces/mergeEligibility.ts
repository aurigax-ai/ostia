import type { WorkspaceKind } from '@/stores/workspaces/workspacesStore'
import {
  type SandboxMergeRefusal,
  type WorkspaceSandbox,
  emptyWorkspaceSandbox,
  sandboxMergeRefusal,
} from '@shared/sandbox/sandbox'

export interface MergeSide {
  id: string
  kind: WorkspaceKind
  workDir: string
  projectDir?: string
  windowId: string | null
  sandbox: WorkspaceSandbox | null
}

export type MergeRefusal = 'self' | 'manager' | 'other-window' | 'other-path' | SandboxMergeRefusal

interface PathOwner {
  workDir: string
  projectDir?: string
}

function expandHome(path: string, home: string | null): string {
  if (!home || (path !== '~' && !path.startsWith('~/'))) return path
  return `${home}${path.slice(1)}`
}

function normalizePath(path: string): string {
  const absolute = path.startsWith('/')
  const tilde = path === '~' || path.startsWith('~/')
  const parts: string[] = []
  for (const part of (tilde ? path.slice(1) : path).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const joined = parts.join('/')
  if (tilde) return joined ? `~/${joined}` : '~'
  return absolute ? `/${joined}` : joined
}

export function inferHome(workspaces: readonly PathOwner[]): string | null {
  for (const w of workspaces) {
    const display = w.projectDir
    if (!display || (display !== '~' && !display.startsWith('~/'))) continue
    const rest = normalizePath(display).slice(1)
    const dir = normalizePath(w.workDir)
    if (!dir.startsWith('/') || !dir.endsWith(rest)) continue
    const home = dir.slice(0, dir.length - rest.length)
    if (home.startsWith('/') && home.length > 1) return home
  }
  return null
}

export function workspacePath(w: PathOwner, home: string | null): string {
  const raw = w.projectDir?.trim() || w.workDir.trim()
  return normalizePath(expandHome(normalizePath(raw), home))
}

export function mergeRefusal(
  source: MergeSide,
  target: MergeSide,
  home: string | null,
): MergeRefusal | null {
  if (source.id === target.id) return 'self'
  if (source.kind === 'manager' || target.kind === 'manager') return 'manager'
  if (workspacePath(source, home) !== workspacePath(target, home)) return 'other-path'
  if (source.windowId !== target.windowId) return 'other-window'
  return sandboxMergeRefusal(
    source.sandbox ?? emptyWorkspaceSandbox(),
    target.sandbox ?? emptyWorkspaceSandbox(),
  )
}

export interface MergeOption {
  targetId: string
  refusal: Exclude<MergeRefusal, 'self' | 'manager' | 'other-path'> | null
}

export function mergeOptions(
  source: MergeSide,
  candidates: readonly MergeSide[],
  home: string | null,
): MergeOption[] {
  const options: MergeOption[] = []
  for (const target of candidates) {
    const refusal = mergeRefusal(source, target, home)
    if (refusal === 'self' || refusal === 'manager' || refusal === 'other-path') continue
    options.push({ targetId: target.id, refusal })
  }
  return options
}
