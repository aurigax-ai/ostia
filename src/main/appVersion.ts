import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { type BuildInfo, parseBuildInfo } from '../shared/buildInfo'

export function readBuildInfo(path: string): BuildInfo | null {
  try {
    return parseBuildInfo(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export function buildInfoPath(): string | null {
  if (app.isPackaged) return join(process.resourcesPath, 'build-info.json')
  if (process.env.ELECTRON_RENDERER_URL) return null
  return join(app.getAppPath(), 'out', 'build-info.json')
}

let running: BuildInfo | null | undefined

export function runningBuild(): BuildInfo | null {
  if (running === undefined) {
    const path = buildInfoPath()
    running = path ? readBuildInfo(path) : null
  }
  return running
}

export function appVersion(): string {
  return runningBuild()?.version ?? app.getVersion()
}
