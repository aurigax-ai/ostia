export type FileOpError =
  | 'outside'
  | 'invalid-name'
  | 'exists'
  | 'into-itself'
  | 'sandboxed'
  | 'not-moved'
  | 'partial'
  | 'failed'

export type FileOpResult =
  | { ok: true; paths: string[] }
  | { ok: false; error: FileOpError; paths?: string[]; partial?: string[] }

export type NewEntryKind = 'file' | 'folder'

export interface FileOpsApi {
  create: (dir: string, name: string, kind: NewEntryKind) => Promise<FileOpResult>
  rename: (path: string, name: string) => Promise<FileOpResult>
  move: (paths: string[], dir: string) => Promise<FileOpResult>
  copy: (paths: string[], dir: string) => Promise<FileOpResult>
  trash: (paths: string[]) => Promise<FileOpResult>
  importDropped: (
    files: File[],
    dir: string,
    workspaceId: string,
    move: boolean,
  ) => Promise<FileOpResult>
  startDrag: (path: string) => void
}
