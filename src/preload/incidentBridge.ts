import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'

export const incidentBridge: Pick<OstiaBridge, 'incidents'> = {
  incidents: {
    list: (period) => ipcRenderer.invoke('incident:list', period),
    report: (ref, words) => ipcRenderer.invoke('incident:report', ref, words),
    save: () => ipcRenderer.invoke('incident:save'),
    openIssue: () => ipcRenderer.invoke('incident:open-issue'),
    clear: () => ipcRenderer.invoke('incident:clear'),
  },
}
