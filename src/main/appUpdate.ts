import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, app, ipcMain } from 'electron'
import { type BuildInfo, parseBuildInfo, sameBuild } from '../shared/buildInfo'

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

function readBuildInfo(path: string): BuildInfo | null {
  try {
    return parseBuildInfo(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
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
    const current = readBuildInfo(path)
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
    app.relaunch()
    quit()
  })
}
