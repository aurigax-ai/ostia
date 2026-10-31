import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SAFE_PATH = /^\/[A-Za-z0-9_./-]+$/
const MAX_DIR_LENGTH = 40
const PERSIST = '10m'
const EXIT_WAIT_MS = 1500

let controlDir: string | null = null

export function controlDirFor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  uid: number | undefined,
): string | null {
  if (platform === 'win32' || uid === undefined) return null
  const runtime = env.XDG_RUNTIME_DIR
  return runtime?.startsWith('/') ? join(runtime, 'ostia-ssh') : `/tmp/ostia-ssh-${uid}`
}

export function prepareControlDir(dir: string | null, uid: number | undefined): string | null {
  if (!dir || uid === undefined || dir.length > MAX_DIR_LENGTH || !SAFE_PATH.test(dir)) return null
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null
  }
  try {
    const stat = lstatSync(dir)
    const trusted = stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0
    return trusted ? dir : null
  } catch {
    return null
  }
}

export function useControlDir(dir: string | null): void {
  controlDir = dir
}

export function sharingOptions(): string[] {
  if (!controlDir) return []
  return [
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${controlDir}/%C`,
    '-o',
    `ControlPersist=${PERSIST}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  ]
}

export function controlPathOption(): string[] {
  return controlDir ? ['-o', `ControlPath=${controlDir}/%C`] : []
}

export function sharingActive(): boolean {
  return controlDir !== null
}

export function exitMasters(dir: string | null = controlDir): void {
  if (!dir) return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    spawnSync('ssh', ['-O', 'exit', '-S', join(dir, name), '--', 'ostia'], {
      stdio: 'ignore',
      timeout: EXIT_WAIT_MS,
    })
  }
}
