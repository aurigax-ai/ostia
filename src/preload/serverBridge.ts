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
    onChanged: (cb) => listen('server:changed', cb),
  },
}
