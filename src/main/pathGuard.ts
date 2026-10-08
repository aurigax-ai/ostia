import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { isRemotePath } from '../shared/remoteFolders'

export function expandHome(p: string, home = homedir()): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

function isInsideRoot(root: string, target: string): boolean {
  if (target === root) return true
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  return target.startsWith(rootWithSep)
}

export function resolveSafe(inputPath: string, roots: string[]): string | null {
  if (isRemotePath(inputPath)) return null
  const resolved = resolve(expandHome(inputPath))
  for (const root of roots) {
    const resolvedRoot = resolve(expandHome(root))
    if (isInsideRoot(resolvedRoot, resolved)) return resolved
  }
  return null
}

export function isPathAllowed(inputPath: string, roots: string[]): boolean {
  return resolveSafe(inputPath, roots) !== null
}
