import { ipcRenderer, webUtils } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { answer, listen } from './listen'

export const filesBridge: Pick<
  OstiaBridge,
  | 'search'
  | 'fs'
  | 'viewers'
  | 'remoteFiles'
  | 'openWaits'
  | 'files'
  | 'openPath'
  | 'fileOps'
  | 'externalEditor'
> = {
  search: {
    run: (req) => ipcRenderer.invoke('search:run', req),
  },
  viewers: {
    open: (request) => ipcRenderer.invoke('viewers:open', request),
    close: (paneId) => ipcRenderer.send('viewers:close', paneId),
    onStopped: (cb) => listen('viewers:stopped', cb),
  },
  fs: {
    list: (path) => ipcRenderer.invoke('fs:list', path),
    read: (path) => ipcRenderer.invoke('fs:read', path),
    stat: (path) => ipcRenderer.invoke('fs:stat', path),
    write: (path, content) => ipcRenderer.invoke('fs:write', path, content),
    version: (path) => ipcRenderer.invoke('fs:version', path),
    readBinary: (path) => ipcRenderer.invoke('fs:read-binary', path),
    watch: (path) => ipcRenderer.invoke('fs:watch', path),
    unwatch: (path) => ipcRenderer.send('fs:unwatch', path),
    onChanged: (cb) => listen('fs:changed', cb),
  },
  remoteFiles: {
    folders: () => ipcRenderer.invoke('remote-files:folders'),
    onFolders: (cb) => listen('remote-files:folders-changed', cb),
    close: (folderId) => ipcRenderer.invoke('remote-files:close', folderId),
    onConfirm: (cb) => answer('remote-files:confirm', 'remote-files:confirm-answer', cb),
    list: (path) => ipcRenderer.invoke('remote-files:list', path),
    stat: (path) => ipcRenderer.invoke('remote-files:stat', path),
    read: (path) => ipcRenderer.invoke('remote-files:read', path),
    write: (path, content, baseVersion) =>
      ipcRenderer.invoke('remote-files:write', path, content, baseVersion),
  },
  openWaits: {
    onEnded: (cb) => listen('open-waits:ended', cb),
  },
  files: {
    pathForFile: (file) => webUtils.getPathForFile(file),
    onKindsChanged: (cb) => listen('files:kinds-changed', cb),
    admitDropped: (files, workspaceId) =>
      ipcRenderer.invoke(
        'files:admit-dropped',
        files.map((file) => webUtils.getPathForFile(file)).filter((path) => path.length > 0),
        workspaceId,
      ),
  },
  openPath: {
    openDefault: (path) => ipcRenderer.invoke('shell:open-default', path),
    canOpenDefault: (path) => ipcRenderer.invoke('shell:can-open-default', path),
    reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
    openLink: (url) => ipcRenderer.invoke('shell:open-link', url),
    project: (dir, exact) => ipcRenderer.invoke('workspace:project', dir, exact),
  },
  fileOps: {
    create: (workspaceId, dir, name, kind) =>
      ipcRenderer.invoke('files:create', workspaceId, dir, name, kind),
    rename: (workspaceId, path, name) =>
      ipcRenderer.invoke('files:rename', workspaceId, path, name),
    move: (workspaceId, paths, dir) => ipcRenderer.invoke('files:move', workspaceId, paths, dir),
    copy: (workspaceId, paths, dir) => ipcRenderer.invoke('files:copy', workspaceId, paths, dir),
    trash: (workspaceId, paths) => ipcRenderer.invoke('files:trash', workspaceId, paths),
    importDropped: (files, dir, workspaceId, move) =>
      ipcRenderer.invoke(
        'files:import',
        files.map((file) => webUtils.getPathForFile(file)).filter((path) => path.length > 0),
        dir,
        workspaceId,
        move,
      ),
    startDrag: (workspaceId, path) => ipcRenderer.send('files:start-drag', workspaceId, path),
  },
  externalEditor: {
    open: (req) => ipcRenderer.invoke('editor:open-external', req),
  },
}
