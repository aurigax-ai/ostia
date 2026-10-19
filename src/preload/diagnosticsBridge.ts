import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const diagnosticsBridge: Pick<OstiaBridge, 'diagnostics' | 'telemetry'> = {
  diagnostics: {
    report: (report) => ipcRenderer.send('diagnostics:report', report),
    ready: (paneIds) => ipcRenderer.send('diagnostics:ready', paneIds),
    reloadWindow: () => ipcRenderer.send('diagnostics:reload-window'),
    toggleDevTools: () => ipcRenderer.send('diagnostics:toggle-devtools'),
    openLogFolder: () => ipcRenderer.invoke('diagnostics:open-log-folder') as Promise<boolean>,
    testHooks: () => ipcRenderer.invoke('diagnostics:test-hooks') as Promise<boolean>,
    onTestCrash: (handler) => listen('diagnostics:test-crash', () => handler()),
  },
  telemetry: {
    state: () => ipcRenderer.invoke('telemetry:state'),
    consented: () => ipcRenderer.invoke('telemetry:consented'),
    categoriesSeen: () => ipcRenderer.invoke('telemetry:categories-seen'),
    resetInstallId: () => ipcRenderer.invoke('telemetry:reset-id'),
    reports: () => ipcRenderer.invoke('telemetry:reports'),
    count: (category, key, id) => ipcRenderer.send('telemetry:count', category, key, id),
  },
}
