import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { ipcMain } from 'electron'
import type { WorkspaceProject } from '../shared/types'
import { resolveSafe } from './pathGuard'

export function findProjectRoot(
  dir: string,
  home: string,
  hasGit: (path: string) => boolean,
): string | null {
  let current = dir
  while (current.startsWith(`${home}/`)) {
    if (hasGit(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

export function describeProject(dir: string, home: string, root: string | null): WorkspaceProject {
  const project = root ?? dir
  const display =
    project === home
      ? '~'
      : project.startsWith(`${home}/`)
        ? `~${project.slice(home.length)}`
        : project
  const name = project === home ? 'home' : basename(project) || project
  return { name, display }
}

export function registerProjectRootIpc(roots: string[]): void {
  const home = homedir()
  ipcMain.handle('workspace:project', (_e, raw: unknown): WorkspaceProject | null => {
    if (typeof raw !== 'string') return null
    const dir = resolveSafe(raw, roots)
    if (!dir) return null
    return describeProject(dir, home, findProjectRoot(dir, home, existsSync))
  })
}
