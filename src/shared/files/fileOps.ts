export type FileOpError =
  | 'outside'
  | 'invalid-name'
  | 'exists'
  | 'into-itself'
  | 'sandboxed'
  | 'not-moved'
  | 'partial'
  | 'no-trash'
  | 'failed'

export type FileOpResult =
  | { ok: true; paths: string[] }
  | { ok: false; error: FileOpError; paths?: string[]; partial?: string[] }

export type NewEntryKind = 'file' | 'folder'

export interface FileOpsApi {
  create: (
    workspaceId: string,
    dir: string,
    name: string,
    kind: NewEntryKind,
  ) => Promise<FileOpResult>
  rename: (workspaceId: string, path: string, name: string) => Promise<FileOpResult>
  move: (workspaceId: string, paths: string[], dir: string) => Promise<FileOpResult>
  copy: (workspaceId: string, paths: string[], dir: string) => Promise<FileOpResult>
  trash: (workspaceId: string, paths: string[]) => Promise<FileOpResult>
  importDropped: (
    files: File[],
    dir: string,
    workspaceId: string,
    move: boolean,
  ) => Promise<FileOpResult>
  startDrag: (workspaceId: string, path: string) => void
}
