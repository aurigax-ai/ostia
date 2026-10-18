import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const boardsBridge: Pick<OstiaBridge, 'git' | 'ports'> = {
  git: {
    watch: (workspaceIds) => ipcRenderer.send('git:watch', workspaceIds),
    shown: () => ipcRenderer.send('git:shown'),
    onItems: (cb) => listen('git:items', cb),
    onChanged: (cb) => listen('git:changed', () => cb()),
    changes: (workspaceId) => ipcRenderer.invoke('git:changes', workspaceId),
    graph: (workspaceId, limit) => ipcRenderer.invoke('git:graph', workspaceId, limit),
    commitFiles: (workspaceId, sha) => ipcRenderer.invoke('git:commit-files', workspaceId, sha),
    blame: (workspaceId, file) => ipcRenderer.invoke('git:blame', workspaceId, file),
    openChange: (workspaceId, path, area) =>
      ipcRenderer.invoke('git:open-change', workspaceId, path, area),
    openCommitFile: (workspaceId, sha, path) =>
      ipcRenderer.invoke('git:open-commit-file', workspaceId, sha, path),
    stage: (workspaceId, req) => ipcRenderer.invoke('git:stage', workspaceId, req),
    unstage: (workspaceId, req) => ipcRenderer.invoke('git:unstage', workspaceId, req),
    commit: (workspaceId, message) => ipcRenderer.invoke('git:commit', workspaceId, message),
    discard: (workspaceId, req) => ipcRenderer.invoke('git:discard', workspaceId, req),
    setScope: (workspaceId, scope) => ipcRenderer.invoke('git:set-scope', workspaceId, scope),
  },
  ports: {
    watch: (workspaceIds) => ipcRenderer.send('ports:watch', workspaceIds),
    onItems: (cb) => listen('ports:items', cb),
  },
}
