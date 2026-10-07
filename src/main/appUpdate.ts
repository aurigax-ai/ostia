import { join } from 'node:path'
import { BrowserWindow, app, ipcMain } from 'electron'
import { type BuildInfo, sameBuild } from '../shared/buildInfo'
import { readBuildInfo, runningBuild } from './appVersion'
import { restoreGpuLaunchEnv } from './discreteGpu'

export const UPDATE_POLL_MS = 30_000

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

function announce(info: BuildInfo): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('app:update-available', info)
  }
}

export function registerAppUpdate(quit: () => void): void {
  let watcher: UpdateWatcher | null = null
  if (app.isPackaged) {
    const path = join(process.resourcesPath, 'build-info.json')
    const current = runningBuild()
    if (current) {
      const w = createUpdateWatcher({
        current,
        read: () => readBuildInfo(path),
        onUpdate: announce,
      })
      watcher = w
      setInterval(() => w.check(), UPDATE_POLL_MS).unref()
      app.on('browser-window-focus', () => w.check())
    }
  }
  ipcMain.handle('app:update-state', () => watcher?.check() ?? watcher?.available() ?? null)
  ipcMain.handle('app:restart', () => {
    restoreGpuLaunchEnv(process.env)
    app.relaunch()
    quit()
  })
}
