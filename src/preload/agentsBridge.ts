import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { answer, listen } from './listen'

export const agentsBridge: Pick<
  OstiaBridge,
  'manager' | 'agentSession' | 'mail' | 'park' | 'claudeAccounts'
> = {
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
    pane: (workspaceId, paneId, titlePinned) =>
      ipcRenderer.invoke('park:pane', workspaceId, paneId, titlePinned),
  },
  claudeAccounts: {
    state: () => ipcRenderer.invoke('claude-accounts:state'),
    onChange: (cb) => listen('claude-accounts:changed', cb),
    add: (workspaceId) => ipcRenderer.invoke('claude-accounts:add', workspaceId),
    remove: (id) => ipcRenderer.invoke('claude-accounts:remove', id),
    use: (id) => ipcRenderer.invoke('claude-accounts:use', id),
    recover: () => ipcRenderer.invoke('claude-accounts:recover'),
    setCheckUsage: (on) => ipcRenderer.invoke('claude-accounts:set-check-usage', on),
    beginSignIn: (id) => ipcRenderer.invoke('claude-accounts:begin-sign-in', id),
    openSignIn: () => ipcRenderer.invoke('claude-accounts:open-sign-in'),
    submitSignInCode: (code) => ipcRenderer.invoke('claude-accounts:submit-code', code),
    cancelSignIn: () => ipcRenderer.invoke('claude-accounts:cancel-sign-in'),
  },
  agentSession: {
    info: (resume) => ipcRenderer.invoke('agent:session-info', resume),
    claimResume: (paneId, resume) => ipcRenderer.invoke('agent:claim-resume', paneId, resume),
    folderTrust: (paneId, sessionId) => ipcRenderer.invoke('agent:folder-trust', paneId, sessionId),
    trustFolder: (paneId, folder) => ipcRenderer.invoke('agent:trust-folder', paneId, folder),
  },
}
