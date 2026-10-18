import { ipcRenderer } from 'electron'
import type { BuildInfo } from '../shared/app/buildInfo'
import type {
  ReleaseState,
  ReplaceStart,
  ReplaceState,
  UpdateRunStart,
  UpdateRunState,
} from '../shared/app/installMethod'
import type { ReleaseCheckResult } from '../shared/app/releases'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const updatesBridge: Pick<OstiaBridge, 'update'> = {
  update: {
    state: () => ipcRenderer.invoke('app:update-state') as Promise<BuildInfo | null>,
    restart: () => ipcRenderer.invoke('app:restart') as Promise<void>,
    onAvailable: (cb) => listen('app:update-available', cb),
    release: () => ipcRenderer.invoke('app:release-state') as Promise<ReleaseState>,
    checkRelease: () => ipcRenderer.invoke('app:release-check') as Promise<ReleaseCheckResult>,
    openRelease: () => ipcRenderer.invoke('app:release-open') as Promise<boolean>,
    dismissRelease: () => ipcRenderer.invoke('app:release-dismiss') as Promise<void>,
    onRelease: (cb) => listen('app:release-available', cb),
    runUpdate: () => ipcRenderer.invoke('app:update-run') as Promise<UpdateRunStart>,
    updateRun: () => ipcRenderer.invoke('app:update-run-state') as Promise<UpdateRunState>,
    onUpdateRun: (cb) => listen('app:update-run-state', cb),
    replaceInstall: () => ipcRenderer.invoke('app:install-replace') as Promise<ReplaceStart>,
    replaceState: () => ipcRenderer.invoke('app:install-replace-state') as Promise<ReplaceState>,
    onReplace: (cb) => listen('app:install-replace-state', cb),
    onProgress: (cb) => listen('app:update-progress', cb),
  },
}
