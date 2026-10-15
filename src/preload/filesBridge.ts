import type {
  RemoteFolder,
  RemoteFolderAsk,
  RemoteListResult,
  RemoteReadResult,
  RemoteStatResult,
  RemoteWriteResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { ipcRenderer, webUtils } from 'electron'
import type { FileOpResult } from '../shared/files/fileOps'
import type { OpenFileVerdict } from '../shared/files/openFiles'
import type { SearchOutcome } from '../shared/files/search'
import type {
  ExternalEditorResult,
  FsBinaryResult,
  FsEntry,
  FsKind,
  FsTextResult,
  OpenPathResult,
  OstiaBridge,
  ViewerOpenResult,
  ViewerStopped,
  WorkspaceProject,
} from '../shared/types'

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
    run: (req) => ipcRenderer.invoke('search:run', req) as Promise<SearchOutcome>,
  },
  viewers: {
    open: (request) => ipcRenderer.invoke('viewers:open', request) as Promise<ViewerOpenResult>,
    close: (paneId) => ipcRenderer.send('viewers:close', paneId),
    onStopped: (cb) => {
      const handler = (_e: Electron.IpcRendererEvent, event: ViewerStopped): void => cb(event)
      ipcRenderer.on('viewers:stopped', handler)
      return () => ipcRenderer.removeListener('viewers:stopped', handler)
    },
  },
  fs: {
    list: (path) => ipcRenderer.invoke('fs:list', path) as Promise<FsEntry[]>,
    read: (path) => ipcRenderer.invoke('fs:read', path) as Promise<FsTextResult>,
    stat: (path) => ipcRenderer.invoke('fs:stat', path) as Promise<FsKind | null>,
    write: (path, content) => ipcRenderer.invoke('fs:write', path, content) as Promise<boolean>,
    version: (path) => ipcRenderer.invoke('fs:version', path) as Promise<string | null>,
    readBinary: (path) => ipcRenderer.invoke('fs:read-binary', path) as Promise<FsBinaryResult>,
    watch: (path) => ipcRenderer.invoke('fs:watch', path) as Promise<boolean>,
    unwatch: (path) => ipcRenderer.send('fs:unwatch', path),
    onChanged: (cb) => {
      const handler = (_e: unknown, change: { path: string; exists: boolean }): void => cb(change)
      ipcRenderer.on('fs:changed', handler)
      return () => ipcRenderer.removeListener('fs:changed', handler)
    },
  },
  remoteFiles: {
    folders: () => ipcRenderer.invoke('remote-files:folders') as Promise<RemoteFolder[]>,
    onFolders: (cb) => {
      const handler = (_e: unknown, folders: RemoteFolder[]): void => cb(folders)
      ipcRenderer.on('remote-files:folders-changed', handler)
      return () => ipcRenderer.removeListener('remote-files:folders-changed', handler)
    },
    close: (folderId) => ipcRenderer.invoke('remote-files:close', folderId) as Promise<boolean>,
    onConfirm: (cb) => {
      const handler = (_e: unknown, requestId: number, ask: RemoteFolderAsk): void => {
        void cb(ask).then((approved) =>
          ipcRenderer.send('remote-files:confirm-answer', requestId, approved),
        )
      }
      ipcRenderer.on('remote-files:confirm', handler)
      return () => ipcRenderer.removeListener('remote-files:confirm', handler)
    },
    list: (path) => ipcRenderer.invoke('remote-files:list', path) as Promise<RemoteListResult>,
    stat: (path) => ipcRenderer.invoke('remote-files:stat', path) as Promise<RemoteStatResult>,
    read: (path) => ipcRenderer.invoke('remote-files:read', path) as Promise<RemoteReadResult>,
    write: (path, content, baseVersion) =>
      ipcRenderer.invoke(
        'remote-files:write',
        path,
        content,
        baseVersion,
      ) as Promise<RemoteWriteResult>,
  },
  openWaits: {
    onEnded: (cb) => {
      const handler = (_e: Electron.IpcRendererEvent, paneIds: string[]): void => cb(paneIds)
      ipcRenderer.on('open-waits:ended', handler)
      return () => ipcRenderer.removeListener('open-waits:ended', handler)
    },
  },
  files: {
    pathForFile: (file) => webUtils.getPathForFile(file),
    admitDropped: (files, workspaceId) =>
      ipcRenderer.invoke(
        'files:admit-dropped',
        files.map((file) => webUtils.getPathForFile(file)).filter((path) => path.length > 0),
        workspaceId,
      ) as Promise<OpenFileVerdict[]>,
  },
  openPath: {
    openDefault: (path) =>
      ipcRenderer.invoke('shell:open-default', path) as Promise<OpenPathResult>,
    reveal: (path) => ipcRenderer.invoke('shell:reveal', path) as Promise<OpenPathResult>,
    openLink: (url) => ipcRenderer.invoke('shell:open-link', url) as Promise<boolean>,
    project: (dir, exact) =>
      ipcRenderer.invoke('workspace:project', dir, exact) as Promise<WorkspaceProject | null>,
  },
  fileOps: {
    create: (dir, name, kind) =>
      ipcRenderer.invoke('files:create', dir, name, kind) as Promise<FileOpResult>,
    rename: (path, name) => ipcRenderer.invoke('files:rename', path, name) as Promise<FileOpResult>,
    move: (paths, dir) => ipcRenderer.invoke('files:move', paths, dir) as Promise<FileOpResult>,
    copy: (paths, dir) => ipcRenderer.invoke('files:copy', paths, dir) as Promise<FileOpResult>,
    trash: (paths) => ipcRenderer.invoke('files:trash', paths) as Promise<FileOpResult>,
  },
  externalEditor: {
    open: (req) => ipcRenderer.invoke('editor:open-external', req) as Promise<ExternalEditorResult>,
  },
}
