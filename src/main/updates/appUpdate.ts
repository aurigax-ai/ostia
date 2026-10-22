import { app, ipcMain } from 'electron'
import { type BuildInfo, sameBuild } from '../../shared/app/buildInfo'
import { restoreGpuLaunchEnv } from '../platform/discreteGpu'
import { relaunchApp } from '../platform/relaunch'
import { packagedBuildInfoPath, readBuildInfo, runningBuild } from './appVersion'

const UPDATE_POLL_MS = 30_000

export interface UpdateWatcher {
  check: () => BuildInfo | null
  available: () => BuildInfo | null
}

export function createUpdateWatcher(deps: {
  current: BuildInfo
  read: () => BuildInfo | null
  onUpdate: (info: BuildInfo) => void
}): UpdateWatcher {
  let announced: BuildInfo | null = null
  return {
    check: () => {
      const disk = deps.read()
      if (!disk || sameBuild(disk, deps.current)) return null
      if (announced && sameBuild(disk, announced)) return announced
      announced = disk
      deps.onUpdate(disk)
      return disk
    },
    available: () => announced,
  }
}

function withoutTelemetry(info: BuildInfo): BuildInfo {
  return { version: info.version, builtAt: info.builtAt }
}

export function registerAppUpdate(
  quit: () => void,
  broadcast: (channel: string, payload: unknown) => void,
): void {
  let watcher: UpdateWatcher | null = null
  if (app.isPackaged) {
    const path = packagedBuildInfoPath()
    const current = runningBuild()
    if (current) {
      const w = createUpdateWatcher({
        current,
        read: () => readBuildInfo(path),
        onUpdate: (info) => broadcast('app:update-available', withoutTelemetry(info)),
      })
      watcher = w
      setInterval(() => w.check(), UPDATE_POLL_MS).unref()
      app.on('browser-window-focus', () => w.check())
    }
  }
  ipcMain.handle('app:update-state', () => {
    const next = watcher?.check() ?? watcher?.available() ?? null
    return next ? withoutTelemetry(next) : null
  })
  ipcMain.handle('app:restart', () => {
    restoreGpuLaunchEnv(process.env)
    relaunchApp()
    quit()
  })
}
