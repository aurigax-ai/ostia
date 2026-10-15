import { ipcRenderer } from 'electron'
import type { CoreItems } from '../shared/boards/git'
import type { OstiaBridge } from '../shared/types'

export const boardsBridge: Pick<OstiaBridge, 'git' | 'ports'> = {
  git: {
    watch: (workspaceIds) => ipcRenderer.send('git:watch', workspaceIds),
    onItems: (cb) => {
      const handler = (_e: unknown, items: CoreItems): void => cb(items)
      ipcRenderer.on('git:items', handler)
      return () => ipcRenderer.removeListener('git:items', handler)
    },
    onChanged: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('git:changed', handler)
      return () => ipcRenderer.removeListener('git:changed', handler)
    },
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
    onItems: (cb) => {
      const handler = (_e: unknown, items: CoreItems): void => cb(items)
      ipcRenderer.on('ports:items', handler)
      return () => ipcRenderer.removeListener('ports:items', handler)
    },
  },
}
