import { mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { app, crashReporter } from 'electron'
import { type EnvSource, envName, readEnv } from '../../shared/appEnv'

export const CRASH_DUMPS_ENV = 'E2E_CRASH_DUMPS'

export function crashDumpDir(packaged: boolean, env: EnvSource): string | null {
  if (packaged) return null
  const dir = readEnv(CRASH_DUMPS_ENV, env)
  return dir && isAbsolute(dir) ? dir : null
}

export function keepTestCrashDumps(): void {
  const dir = crashDumpDir(app.isPackaged, process.env)
  delete process.env[envName(CRASH_DUMPS_ENV)]
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  app.setPath('crashDumps', dir)
  crashReporter.start({ uploadToServer: false })
}
