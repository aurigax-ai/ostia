import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { answer, listen } from './listen'

export const agentsBridge: Pick<OstiaBridge, 'manager' | 'agentSession' | 'mail' | 'park'> = {
  manager: {
    onOpen: (cb) => {
      const off = answer('manager:open', 'manager:open-result', cb)
      ipcRenderer.send('manager:ready')
      return off
    },
  },
  mail: {
    snapshot: () => ipcRenderer.invoke('bus:mail-snapshot'),
    onChange: (cb) => listen('bus:mail', cb),
    dismiss: (paneId) => ipcRenderer.invoke('bus:mail-dismiss', paneId),
  },
  park: {
    pane: (workspaceId, paneId) => ipcRenderer.invoke('park:pane', workspaceId, paneId),
  },
  agentSession: {
    info: (resume) => ipcRenderer.invoke('agent:session-info', resume),
    claimResume: (paneId, resume) => ipcRenderer.invoke('agent:claim-resume', paneId, resume),
    folderTrust: (paneId) => ipcRenderer.invoke('agent:folder-trust', paneId),
    trustFolder: (paneId, folder) => ipcRenderer.invoke('agent:trust-folder', paneId, folder),
  },
}
