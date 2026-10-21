import { isAbsolute } from 'node:path'
import { DIFF_TEXT_MAX, panelPath } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type {
  ExtensionOpenDiffRequest,
  ExtensionOpenFileRequest,
  ExtensionOpenPanelRequest,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { PaneIdentity } from '../control/idRegistry'
import type { RemoteFolders } from '../files/remoteFolders'
import type { ExtensionHostDeps } from './extensionHostDeps'
import { fail, type Runtime } from './extensionRuntime'

const DIFF_TITLE_MAX = 200

const DIFF_LANGUAGE_MAX = 40

function filePosition(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

export interface ExtensionWindowRequestsHost {
  deps: Pick<
    ExtensionHostDeps,
    'notify' | 'notifyPanel' | 'openDiffIn' | 'openFileIn' | 'openPanelIn'
  >
  runtimeOf(identity: PaneIdentity, conn: MessageConnection): Runtime
  remoteFolders: RemoteFolders | null
  shownName(rt: Runtime): string
}

export class ExtensionWindowRequests {
  constructor(private readonly host: ExtensionWindowRequestsHost) {}

  notify(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const p = (params ?? {}) as { title?: unknown; body?: unknown; openPanel?: unknown }
    const title = typeof p.title === 'string' ? p.title.trim().slice(0, 256) : ''
    if (!title) return fail('missing-title')
    const body = typeof p.body === 'string' && p.body.trim() ? p.body.slice(0, 1024) : undefined
    const path = typeof p.openPanel === 'string' ? panelPath(p.openPanel) : null
    if (typeof p.openPanel === 'string' && !path) {
      return fail('invalid-params', "openPanel must be true or a path starting with '/'")
    }
    const from = `extension:${rt.ext.manifest.id}`
    const wantsPanel = p.openPanel === true || path !== null
    if (wantsPanel && rt.ext.manifest.contributes.panel && this.host.deps.notifyPanel) {
      const req: ExtensionOpenPanelRequest = { extId: rt.ext.manifest.id }
      if (path) req.path = path
      const n = path
        ? { title, body, from, extId: req.extId, panelPath: path }
        : { title, body, from, extId: req.extId }
      this.host.deps.notifyPanel(n, () => this.host.deps.openPanelIn(req))
    } else {
      this.host.deps.notify({ title, body, from })
    }
    return { ok: true }
  }

  openPanel(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    if (!rt.ext.manifest.contributes.panel) return fail('not-contributed', 'no panel in manifest')
    const p = (params ?? {}) as { workspaceId?: unknown; path?: unknown }
    const req: ExtensionOpenPanelRequest = { extId: rt.ext.manifest.id }
    if (typeof p.workspaceId === 'string' && p.workspaceId) req.workspaceId = p.workspaceId
    if (p.path !== undefined) {
      const path = panelPath(p.path)
      if (!path) return fail('invalid-params', "path must start with '/'")
      req.path = path
    }
    this.host.deps.openPanelIn(req)
    return { ok: true }
  }

  openDiff(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const p = (params ?? {}) as Record<string, unknown>
    const title = typeof p.title === 'string' ? p.title.trim().slice(0, DIFF_TITLE_MAX) : ''
    if (!title) return fail('missing-title')
    if (typeof p.original !== 'string' || typeof p.modified !== 'string') {
      return fail('invalid-params', 'original and modified must be strings')
    }
    if (p.original.length > DIFF_TEXT_MAX || p.modified.length > DIFF_TEXT_MAX) {
      return fail('too-large', `each side is limited to ${DIFF_TEXT_MAX} characters`)
    }
    if (p.path !== undefined && (typeof p.path !== 'string' || !isAbsolute(p.path))) {
      return fail('invalid-params', 'path must be absolute')
    }
    const req: ExtensionOpenDiffRequest = {
      extId: rt.ext.manifest.id,
      title,
      original: p.original,
      modified: p.modified,
    }
    if (typeof p.language === 'string' && p.language) {
      req.language = p.language.slice(0, DIFF_LANGUAGE_MAX)
    }
    if (typeof p.path === 'string') req.path = p.path
    if (typeof p.workspaceId === 'string' && p.workspaceId) req.workspaceId = p.workspaceId
    if (!this.host.deps.openDiffIn) return fail('no-window')
    this.host.deps.openDiffIn(req)
    return { ok: true }
  }

  async openFile(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const p = (params ?? {}) as Record<string, unknown>
    if (typeof p.workspaceId !== 'string' || !p.workspaceId) return fail('missing-workspace')
    if (typeof p.path !== 'string' || !isAbsolute(p.path)) {
      return fail('invalid-params', 'path must be absolute')
    }
    const req: ExtensionOpenFileRequest = {
      extId: rt.ext.manifest.id,
      workspaceId: p.workspaceId,
      path: p.path,
    }
    const line = filePosition(p.line)
    if (line) {
      req.line = line
      const column = filePosition(p.column)
      if (column) req.column = column
    }
    if (!this.host.deps.openFileIn) return fail('no-window')
    return this.host.deps.openFileIn(req)
  }

  async openFolder(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    if (!this.host.remoteFolders) return fail('no-window')
    return this.host.remoteFolders.open(
      { id: rt.ext.manifest.id, name: this.host.shownName(rt) },
      params,
    )
  }

  closeFolder(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const folderId = (params as { folderId?: unknown } | null)?.folderId
    const closed = this.host.remoteFolders?.closeByExtension(rt.ext.manifest.id, folderId) ?? false
    return closed ? { ok: true } : fail('unknown-folder')
  }
}
