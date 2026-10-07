import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SpawnFolder {
  cwd: string
  missing: boolean
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
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

export function sandboxCwd(cwd: string, workDir: string | undefined): string {
  if (!workDir) return cwd
  return cwd === workDir || cwd.startsWith(`${workDir}/`) ? cwd : workDir
}
