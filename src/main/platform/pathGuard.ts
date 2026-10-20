import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isRemotePath } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { isArchivePath } from '../../shared/archives/archivePaths'

export function expandHome(p: string, home = homedir()): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

export function isInsidePath(base: string, path: string): boolean {
  if (!isAbsolute(base) || !isAbsolute(path)) return false
  const rel = relative(base, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function resolveSafe(inputPath: string, roots: string[]): string | null {
  if (isRemotePath(inputPath) || isArchivePath(inputPath)) return null
  const resolved = resolve(expandHome(inputPath))
  for (const root of roots) {
    const resolvedRoot = resolve(expandHome(root))
    if (isInsidePath(resolvedRoot, resolved)) return resolved
  }
  return null
}
