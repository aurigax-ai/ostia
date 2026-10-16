import type {
  SnippetListing,
  SnippetSaveResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/snippets'
import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import type { ViewListing } from '../shared/views/views'
import type { CmuxSessionRead } from '../shared/workspaces/cmuxSession'
import type {
  AppSnapshot,
  PaneMoveResult,
  WorkspaceMergeResult,
} from '../shared/workspaces/workspaceApi'
import { listen } from './listen'

export const workspaceBridge: Pick<OstiaBridge, 'workspace' | 'scratch' | 'snippets' | 'views'> = {
  workspace: {
    save: (snapshot) => ipcRenderer.send('workspace:save', snapshot),
    load: () => ipcRenderer.invoke('workspace:load') as Promise<AppSnapshot | null>,
    merge: (sourceId, targetId) =>
      ipcRenderer.invoke('workspace:merge', sourceId, targetId) as Promise<WorkspaceMergeResult>,
    movePanes: (sourceId, targetId, paneIds) =>
      ipcRenderer.invoke(
        'workspace:move-panes',
        sourceId,
        targetId,
        paneIds,
      ) as Promise<PaneMoveResult>,
    readCmux: (path) => ipcRenderer.invoke('workspace:read-cmux', path) as Promise<CmuxSessionRead>,
  },
  scratch: {
    create: () => ipcRenderer.invoke('scratch:create') as Promise<string | null>,
    files: (workspaceId) => ipcRenderer.invoke('scratch:files', workspaceId) as Promise<number>,
    reveal: (workspaceId) => ipcRenderer.send('scratch:reveal', workspaceId),
  },
  snippets: {
    list: (workspaceId) =>
      ipcRenderer.invoke('snippets:list', workspaceId) as Promise<SnippetListing>,
    save: (doc) => ipcRenderer.invoke('snippets:save', doc) as Promise<SnippetSaveResult>,
  },
  views: {
    list: () => ipcRenderer.invoke('views:list') as Promise<ViewListing>,
    setEnabled: (name, enabled) =>
      ipcRenderer.invoke('views:set-enabled', name, enabled) as Promise<ViewListing>,
    reveal: (name) => ipcRenderer.invoke('views:reveal', name) as Promise<boolean>,
    onChanged: (cb) => listen('views:changed', cb),
  },
}
