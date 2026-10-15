import { ipcRenderer } from 'electron'
import type { BuildInfo } from '../shared/app/buildInfo'
import type {
  ReleaseState,
  ReplaceProgress,
  ReplaceStart,
  ReplaceState,
  UpdateRunStart,
  UpdateRunState,
} from '../shared/app/installMethod'
import type { ReleaseCheckResult } from '../shared/app/releases'
import type { OstiaBridge } from '../shared/types'

export const updatesBridge: Pick<OstiaBridge, 'update'> = {
  update: {
    state: () => ipcRenderer.invoke('app:update-state') as Promise<BuildInfo | null>,
    restart: () => ipcRenderer.invoke('app:restart') as Promise<void>,
    onAvailable: (cb) => {
      const handler = (_event: unknown, info: BuildInfo): void => cb(info)
      ipcRenderer.on('app:update-available', handler)
      return () => ipcRenderer.removeListener('app:update-available', handler)
    },
    release: () => ipcRenderer.invoke('app:release-state') as Promise<ReleaseState>,
    checkRelease: () => ipcRenderer.invoke('app:release-check') as Promise<ReleaseCheckResult>,
    openRelease: () => ipcRenderer.invoke('app:release-open') as Promise<boolean>,
    dismissRelease: () => ipcRenderer.invoke('app:release-dismiss') as Promise<void>,
    onRelease: (cb) => {
      const handler = (_event: unknown, state: ReleaseState): void => cb(state)
      ipcRenderer.on('app:release-available', handler)
      return () => ipcRenderer.removeListener('app:release-available', handler)
    },
    runUpdate: () => ipcRenderer.invoke('app:update-run') as Promise<UpdateRunStart>,
    updateRun: () => ipcRenderer.invoke('app:update-run-state') as Promise<UpdateRunState>,
    onUpdateRun: (cb) => {
      const handler = (_event: unknown, state: UpdateRunState): void => cb(state)
      ipcRenderer.on('app:update-run-state', handler)
      return () => ipcRenderer.removeListener('app:update-run-state', handler)
    },
    replaceInstall: () => ipcRenderer.invoke('app:install-replace') as Promise<ReplaceStart>,
    replaceState: () => ipcRenderer.invoke('app:install-replace-state') as Promise<ReplaceState>,
    onReplace: (cb) => {
      const handler = (_event: unknown, state: ReplaceState): void => cb(state)
      ipcRenderer.on('app:install-replace-state', handler)
      return () => ipcRenderer.removeListener('app:install-replace-state', handler)
    },
    onProgress: (cb) => {
      const handler = (_event: unknown, progress: ReplaceProgress): void => cb(progress)
      ipcRenderer.on('app:update-progress', handler)
      return () => ipcRenderer.removeListener('app:update-progress', handler)
    },
  },
}
