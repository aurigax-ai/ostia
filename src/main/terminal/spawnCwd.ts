import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { expandHome, isInsidePath } from '../platform/pathGuard'

export interface SpawnFolder {
  cwd: string
  missing: boolean
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function spawnFolder(cwd: string | undefined, home = homedir()): SpawnFolder {
  if (cwd === undefined) return { cwd: home, missing: false }
  const p = expandHome(cwd, home)
  return isDirectory(p) ? { cwd: p, missing: false } : { cwd: home, missing: true }
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

export function sandboxCwd(cwd: string, workDir: string | undefined): string {
  if (!workDir) return cwd
  const root = realOrNull(workDir)
  const real = realOrNull(cwd)
  return root !== null && real !== null && isInsidePath(root, real) ? real : workDir
}
