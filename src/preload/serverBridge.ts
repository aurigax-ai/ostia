import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const serverBridge: Pick<OstiaBridge, 'server'> = {
  server: {
    status: () => ipcRenderer.invoke('server:status'),
    setUrl: (url) => ipcRenderer.invoke('server:set-url', url),
    info: () => ipcRenderer.invoke('server:info'),
    signInWithInvite: (code) => ipcRenderer.invoke('server:sign-in-invite', code),
    githubStart: () => ipcRenderer.invoke('server:github-start'),
    githubPoll: () => ipcRenderer.invoke('server:github-poll'),
    githubCancel: () => ipcRenderer.invoke('server:github-cancel'),
    openVerification: () => ipcRenderer.invoke('server:open-verification'),
    signOut: () => ipcRenderer.invoke('server:sign-out'),
    devices: () => ipcRenderer.invoke('server:devices'),
    markSeen: (deviceId) => ipcRenderer.invoke('server:device-seen', deviceId),
    createInvite: () => ipcRenderer.invoke('server:invite-create'),
    elevationStart: (method) => ipcRenderer.invoke('server:elevation-start', method),
    elevationPoll: () => ipcRenderer.invoke('server:elevation-poll'),
    elevationCancel: () => ipcRenderer.invoke('server:elevation-cancel'),
    approvals: () => ipcRenderer.invoke('server:approvals'),
    approve: (approvalId) => ipcRenderer.invoke('server:approve', approvalId),
    onChanged: (cb) => listen('server:changed', cb),
    onDevicesChanged: (cb) => listen('server:devices-changed', () => cb()),
  },
}
