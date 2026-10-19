import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { answer } from './listen'

export const agentsBridge: Pick<OstiaBridge, 'manager' | 'agentSession'> = {
  manager: {
    onOpen: (cb) => {
      const off = answer('manager:open', 'manager:open-result', cb)
      ipcRenderer.send('manager:ready')
      return off
    },
  },
  agentSession: {
    info: (resume) => ipcRenderer.invoke('agent:session-info', resume),
    claimResume: (paneId, resume) => ipcRenderer.invoke('agent:claim-resume', paneId, resume),
    folderTrust: (paneId) => ipcRenderer.invoke('agent:folder-trust', paneId),
    trustFolder: (paneId, folder) => ipcRenderer.invoke('agent:trust-folder', paneId, folder),
  },
}
