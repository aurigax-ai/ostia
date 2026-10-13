import { randomBytes } from 'node:crypto'
import {
  REMOTE_FILE_MAX_BYTES,
  REMOTE_FOLDERS_PER_WORKSPACE,
  REMOTE_HOST_PATTERN,
  REMOTE_VERSION_PATTERN,
  REMOTE_WRITE_ANY,
  REMOTE_WRITE_NEW,
  type RemoteFailure,
  type RemoteFileError,
  type RemoteFilesRequest,
  type RemoteFolder,
  type RemoteFolderAsk,
  type RemoteListResult,
  type RemoteReadResult,
  type RemoteStatResult,
  type RemoteWriteResult,
  isInsideRoot,
  normalizeRemoteListing,
  normalizeRemotePath,
  normalizeRemoteRead,
  normalizeRemoteStat,
  normalizeRemoteWrite,
  parseRemotePath,
  utf8Length,
} from '../../shared/remoteFolders'

export const REMOTE_REQUEST_TIMEOUT_MS = 30_000

export interface RemoteFolderConfirm extends RemoteFolderAsk {
  extId: string
  workspaceId: string
}

export interface RemoteFoldersDeps {
  windowOfWorkspace: (workspaceId: string) => string | undefined
  refusal: (workspaceId: string) => 'sandboxed' | 'scratch' | null
  confirm: (req: RemoteFolderConfirm) => Promise<boolean>
  request: (extId: string, req: RemoteFilesRequest) => Promise<unknown>
  closed: (folder: RemoteFolder) => void
  publish: () => void
  newId?: () => string
}

export type OpenFolderResult =
  | { ok: true; folderId: string }
  | { ok: false; error: string; message?: string }

function refused(error: string, message?: string): OpenFolderResult {
  return message ? { ok: false, error, message } : { ok: false, error }
}

function failed(error: RemoteFileError): RemoteFailure {
  return { ok: false, error }
}

function randomId(): string {
  return randomBytes(6).toString('hex')
}

export class RemoteFolders {
  private readonly folders = new Map<string, RemoteFolder>()

  constructor(private readonly deps: RemoteFoldersDeps) {}

  async open(ext: { id: string; name: string }, params: unknown): Promise<OpenFolderResult> {
    const p = (params ?? {}) as Record<string, unknown>
    const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId : ''
    if (!workspaceId || this.deps.windowOfWorkspace(workspaceId) === undefined) {
      return refused('unknown-workspace', 'workspaceId is not an open workspace')
    }
    const restricted = this.deps.refusal(workspaceId)
    if (restricted) return refused(restricted, `a ${restricted} workspace has no remote folders`)
    if (typeof p.host !== 'string' || !REMOTE_HOST_PATTERN.test(p.host)) {
      return refused('invalid-params', 'host must be a plain host name')
    }
    const root = normalizeRemotePath(p.path)
    if (root === null) return refused('invalid-params', 'path must be absolute, without ..')
    const existing = this.inWorkspace(workspaceId).find(
      (f) => f.extId === ext.id && f.host === p.host && f.root === root,
    )
    if (existing) return { ok: true, folderId: existing.id }
    if (this.inWorkspace(workspaceId).length >= REMOTE_FOLDERS_PER_WORKSPACE) {
      return refused('too-many', `a workspace holds ${REMOTE_FOLDERS_PER_WORKSPACE} remote folders`)
    }
    const approved = await this.deps.confirm({
      extId: ext.id,
      workspaceId,
      extName: ext.name,
      host: p.host,
      path: root,
    })
    if (!approved) return refused('denied', 'the human did not open the folder')
    if (this.deps.windowOfWorkspace(workspaceId) === undefined) {
      return refused('unknown-workspace', 'the workspace closed')
    }
    const folder: RemoteFolder = {
      id: (this.deps.newId ?? randomId)(),
      workspaceId,
      extId: ext.id,
      extName: ext.name,
      host: p.host,
      root,
    }
    this.folders.set(folder.id, folder)
    this.deps.publish()
    return { ok: true, folderId: folder.id }
  }

  private inWorkspace(workspaceId: string): RemoteFolder[] {
    return [...this.folders.values()].filter((f) => f.workspaceId === workspaceId)
  }

  ownerChanged(workspaceId: string): void {
    if (this.inWorkspace(workspaceId).length > 0) this.deps.publish()
  }

  forWindow(windowId: string): RemoteFolder[] {
    return [...this.folders.values()].filter(
      (f) => this.deps.windowOfWorkspace(f.workspaceId) === windowId,
    )
  }

  private closeWhere(match: (folder: RemoteFolder) => boolean, tell: boolean): number {
    const gone = [...this.folders.values()].filter(match)
    for (const folder of gone) {
      this.folders.delete(folder.id)
      if (tell) this.deps.closed(folder)
    }
    if (gone.length > 0) this.deps.publish()
    return gone.length
  }

  closeByExtension(extId: string, folderId: unknown): boolean {
    return this.closeWhere((f) => f.id === folderId && f.extId === extId, false) > 0
  }

  closeByWindow(windowId: string, folderId: unknown): boolean {
    return (
      this.closeWhere(
        (f) => f.id === folderId && this.deps.windowOfWorkspace(f.workspaceId) === windowId,
        true,
      ) > 0
    )
  }

  workspaceClosed(workspaceId: string): void {
    this.closeWhere((f) => f.workspaceId === workspaceId, true)
  }

  extensionGone(extId: string): void {
    this.closeWhere((f) => f.extId === extId, false)
  }

  private locate(
    windowId: string,
    raw: unknown,
  ): { folder: RemoteFolder; path: string } | RemoteFailure {
    const parsed = parseRemotePath(raw)
    if (!parsed) return failed('invalid-path')
    const folder = this.folders.get(parsed.folderId)
    if (!folder || this.deps.windowOfWorkspace(folder.workspaceId) !== windowId) {
      return failed('unknown-folder')
    }
    if (!isInsideRoot(folder.root, parsed.path)) return failed('outside')
    return { folder, path: parsed.path }
  }

  private async ask(
    folder: RemoteFolder,
    req: Omit<RemoteFilesRequest, 'folderId' | 'root'>,
  ): Promise<unknown> {
    try {
      return await this.deps.request(folder.extId, {
        ...req,
        folderId: folder.id,
        root: folder.root,
      })
    } catch {
      return { ok: false, error: 'unavailable' }
    }
  }

  async list(windowId: string, raw: unknown): Promise<RemoteListResult> {
    const at = this.locate(windowId, raw)
    if ('ok' in at) return at
    return normalizeRemoteListing(await this.ask(at.folder, { op: 'list', path: at.path }))
  }

  async stat(windowId: string, raw: unknown): Promise<RemoteStatResult> {
    const at = this.locate(windowId, raw)
    if ('ok' in at) return at
    return normalizeRemoteStat(await this.ask(at.folder, { op: 'stat', path: at.path }))
  }

  async read(windowId: string, raw: unknown): Promise<RemoteReadResult> {
    const at = this.locate(windowId, raw)
    if ('ok' in at) return at
    return normalizeRemoteRead(await this.ask(at.folder, { op: 'read', path: at.path }))
  }

  async write(
    windowId: string,
    raw: unknown,
    content: unknown,
    baseVersion: unknown,
  ): Promise<RemoteWriteResult> {
    const at = this.locate(windowId, raw)
    if ('ok' in at) return at
    if (typeof content !== 'string' || content.includes('\u0000')) return failed('binary')
    if (content.length > REMOTE_FILE_MAX_BYTES || utf8Length(content) > REMOTE_FILE_MAX_BYTES) {
      return failed('too-large')
    }
    const known =
      baseVersion === REMOTE_WRITE_ANY ||
      baseVersion === REMOTE_WRITE_NEW ||
      (typeof baseVersion === 'string' && REMOTE_VERSION_PATTERN.test(baseVersion))
    if (!known) return failed('failed')
    return normalizeRemoteWrite(
      await this.ask(at.folder, {
        op: 'write',
        path: at.path,
        content,
        baseVersion: baseVersion as string,
      }),
    )
  }
}
