import type {
  RemoteFolder,
  RemoteFolderAsk,
  RemoteListResult,
  RemoteReadResult,
  RemoteStatResult,
  RemoteWriteResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import type { FileUrlTarget } from './fileUrls'
import type { OpenFileVerdict } from './openFiles'

export interface FsEntry {
  name: string
  dir: boolean
  archive?: true
  link?: string
  encrypted?: true
}

export interface ViewerOpenRequest {
  workspaceId: string
  paneId: string
  path: string
  viewType: string
}

export type ViewerOpenResult =
  | { ok: true; src: string; partition: string }
  | { ok: false; error: 'denied' | 'unknown-viewer' }

export type ViewerStopReason = 'memory' | 'unresponsive'

export interface ViewerStopped {
  paneId: string
  reason: ViewerStopReason
}

interface ViewersApi {
  open: (request: ViewerOpenRequest) => Promise<ViewerOpenResult>
  close: (paneId: string) => void
  onStopped: (cb: (event: ViewerStopped) => void) => () => void
}

interface FsApi {
  list: (path: string) => Promise<FsEntry[]>
  read: (path: string) => Promise<FsTextResult>
  write: (path: string, content: string) => Promise<boolean>
  version: (path: string) => Promise<string | null>
  stat: (path: string) => Promise<FsKind | null>
  readBinary: (path: string) => Promise<FsBinaryResult>
  watch: (path: string) => Promise<boolean>
  unwatch: (path: string) => void
  onChanged: (cb: (change: { path: string; exists: boolean }) => void) => () => void
}

interface RemoteFilesApi {
  folders: () => Promise<RemoteFolder[]>
  onFolders: (cb: (folders: RemoteFolder[]) => void) => () => void
  close: (folderId: string) => Promise<boolean>
  onConfirm: (cb: (ask: RemoteFolderAsk) => Promise<boolean>) => () => void
  list: (path: string) => Promise<RemoteListResult>
  stat: (path: string) => Promise<RemoteStatResult>
  read: (path: string) => Promise<RemoteReadResult>
  write: (path: string, content: string, baseVersion: string) => Promise<RemoteWriteResult>
}

export type ArchiveEntryProblem = 'encrypted' | 'link' | 'unzip-limit' | 'gone'

export type FsBinaryResult =
  | { ok: true; data: Uint8Array }
  | { ok: false; error: 'denied' | 'unreadable' }
  | { ok: false; error: 'too-large'; size: number }
  | { ok: false; error: 'archive'; reason: ArchiveEntryProblem }

export type FsTextResult =
  | { ok: true; text: string; version: string }
  | { ok: false; error: 'missing' | 'denied' | 'unreadable' | 'binary' }
  | { ok: false; error: 'too-large'; size: number }
  | { ok: false; error: 'archive'; reason: ArchiveEntryProblem }

export type FsKind = 'file' | 'dir'

export interface WorkspaceProject {
  name: string
  display: string
  dir: string
  repo: boolean
}

export type OpenPathResult = { ok: true } | { ok: false; error: 'not-found' | 'program' | 'failed' }

interface FilesApi {
  pathForFile: (file: File) => string
  onKindsChanged: (cb: () => void) => () => void
  admitDropped: (files: File[], workspaceId: string | null) => Promise<OpenFileVerdict[]>
}

interface TerminalLinksApi {
  probe: (paneId: string, path: string) => Promise<FsKind | null>
  admit: (paneId: string, written: string) => Promise<OpenFileVerdict | null>
  openDefault: (paneId: string, written: string) => Promise<OpenPathResult>
  showInFolder: (paneId: string, written: string) => Promise<OpenPathResult>
  fileUrl: (paneId: string, url: string) => Promise<FileUrlTarget | null>
  openFileUrl: (paneId: string, url: string) => Promise<OpenPathResult>
}

interface OpenPathApi {
  openDefault: (path: string) => Promise<OpenPathResult>
  canOpenDefault: (path: string) => Promise<boolean>
  reveal: (path: string) => Promise<OpenPathResult>
  openLink: (url: string) => Promise<boolean>
  project: (dir: string, exact?: boolean) => Promise<WorkspaceProject | null>
}

export interface FilesBridge {
  fs: FsApi
  viewers: ViewersApi
  remoteFiles: RemoteFilesApi
  openPath: OpenPathApi
  files: FilesApi
  terminalLinks: TerminalLinksApi
}
