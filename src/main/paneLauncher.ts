import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { shellEnv } from '../shared/appEnv'

export const OSTIA_LAUNCHER_NAME = 'ostia'

export function ostiaLauncherScript(): string {
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${shellEnv('NODE')}" "${shellEnv('CLI')}" "$@"\n`
}

export function writeOstiaLauncher(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, OSTIA_LAUNCHER_NAME)
  const next = `${path}.${process.pid}.new`
  writeFileSync(next, ostiaLauncherScript(), { mode: 0o700 })
  renameSync(next, path)
}

export function withLauncherOnPath(
  env: Record<string, string>,
  dir: string,
  delimiter: string,
): Record<string, string> {
  const rest = (env.PATH ?? '').split(delimiter).filter((entry) => entry !== '' && entry !== dir)
  return { ...env, PATH: [dir, ...rest].join(delimiter) }
}
