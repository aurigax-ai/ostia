import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const updatesBridge: Pick<OstiaBridge, 'update'> = {
  update: {
    state: () => ipcRenderer.invoke('app:update-state'),
    restart: () => ipcRenderer.invoke('app:restart'),
    onAvailable: (cb) => listen('app:update-available', cb),
    release: () => ipcRenderer.invoke('app:release-state'),
    checkRelease: () => ipcRenderer.invoke('app:release-check'),
    openRelease: () => ipcRenderer.invoke('app:release-open'),
    dismissRelease: () => ipcRenderer.invoke('app:release-dismiss'),
    onRelease: (cb) => listen('app:release-available', cb),
    runUpdate: () => ipcRenderer.invoke('app:update-run'),
    updateRun: () => ipcRenderer.invoke('app:update-run-state'),
    onUpdateRun: (cb) => listen('app:update-run-state', cb),
    replaceInstall: () => ipcRenderer.invoke('app:install-replace'),
    replaceState: () => ipcRenderer.invoke('app:install-replace-state'),
    onReplace: (cb) => listen('app:install-replace-state', cb),
    onProgress: (cb) => listen('app:update-progress', cb),
  },
}
