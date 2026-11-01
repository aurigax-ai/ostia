import { hash } from 'node:crypto'
import { mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { lstat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ViewerPortableTables } from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import { ipcMain } from 'electron'
import { escape as escapeHtml } from 'es-toolkit'
import { normalizePreviewTheme, type PreviewTheme } from '../../shared/artifacts/htmlPreview'
import {
  documentPage,
  PORTABLE_FORMAT,
  PORTABLE_LIMITS,
  type PortableAction,
  type PortableDocument,
  type PortableManifest,
  type PortableRequest,
  type PortableResult,
  type PortableType,
  portableFileName,
  portableType,
  runsScripts,
  wrapPortable,
} from '../../shared/artifacts/portable'
import { type PublishOptions, SHARE_PASSWORD_MAX } from '../../shared/artifacts/shares'
import { isInsidePath } from '../platform/pathGuard'
import type { PortableBuilder } from './portableBuilder'
import { problemText } from './portableBundle'
import { type PublishedTables, tablesDocument } from './portableTables'
import { readRegularFile } from './previewFiles'
import type { ShareService } from './shares/shareService'

const SWEEP_AGE_MS = 24 * 60 * 60 * 1000

export interface PortableExportDeps {
  builder: Pick<PortableBuilder, 'build'>
  confine: (path: string) => string | null
  servesFolder: (dir: string) => boolean
  ownsWorkspace: (windowId: string, workspaceId: string) => boolean
  sandboxedFolders: () => string[]
  tmpDir: () => string
  openPath: (path: string) => Promise<string>
  saveDialog: (windowId: string, defaultPath: string) => Promise<string | null>
  downloads: () => string
  writeClipboard: (text: string) => void
  version: string
  publishedTables: (windowId: string, path: string) => PublishedTables
  awaitTables: (windowId: string, path: string) => Promise<PublishedTables>
  now?: () => number
}

type Made = { ok: true; file: string } | (PortableResult & { ok: false })

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

const IMAGE_CSS =
  'body{display:flex;align-items:center;justify-content:center;min-height:100vh}img{max-width:100%;max-height:100vh}'
const JSON_CSS =
  'pre{margin:0;padding:16px;font-family:var(--ostia-font-code,ui-monospace,monospace);white-space:pre-wrap;word-break:break-word}'

function normalizeDocument(value: unknown): PortableDocument | null {
  const raw = value as Partial<PortableDocument> | null
  if (!raw || typeof raw.body !== 'string' || typeof raw.css !== 'string') return null
  if (raw.body.length + raw.css.length > PORTABLE_LIMITS.fileBytes) return null
  return { body: raw.body, css: raw.css }
}

function normalizePortableRequest(value: unknown): PortableRequest | null {
  const raw = value as Partial<PortableRequest> | null
  if (!raw || typeof raw.workspaceId !== 'string' || typeof raw.path !== 'string') return null
  const document = raw.document === undefined ? undefined : normalizeDocument(raw.document)
  if (document === null) return null
  const publish = raw.publish === undefined ? undefined : normalizePublish(raw.publish)
  if (publish === null) return null
  return {
    ...(raw.awaitTables === true ? { awaitTables: true } : {}),
    workspaceId: raw.workspaceId,
    path: raw.path,
    theme: normalizePreviewTheme(raw.theme),
    ...(document ? { document } : {}),
    ...(publish ? { publish } : {}),
  }
}

const DIGEST_MAX = 128
const SHARE_MODES: readonly unknown[] = ['link', 'password', 'public']

function normalizePublish(value: unknown): PublishOptions | null {
  const raw = value as Partial<PublishOptions> | null
  if (!raw || typeof raw !== 'object') return null
  if (!SHARE_MODES.includes(raw.mode)) return null
  if (typeof raw.password !== 'string' || raw.password.length > SHARE_PASSWORD_MAX * 4) return null
  if (typeof raw.withLinkKey !== 'boolean') return null
  if (typeof raw.acceptedDigest !== 'string' || raw.acceptedDigest.length > DIGEST_MAX) return null
  if (!Number.isSafeInteger(raw.expiresInSeconds)) return null
  return {
    mode: raw.mode as PublishOptions['mode'],
    password: raw.password,
    withLinkKey: raw.withLinkKey,
    expiresInSeconds: raw.expiresInSeconds as number,
    acceptedDigest: raw.acceptedDigest,
  }
}

export class PortableExport {
  private readonly now: () => number
  private shares: ShareService | null = null

  constructor(private readonly deps: PortableExportDeps) {
    this.now = deps.now ?? Date.now
  }

  useShares(shares: ShareService): void {
    this.shares = shares
  }

  async run(
    windowId: string,
    action: PortableAction,
    request: PortableRequest,
  ): Promise<PortableResult> {
    if (!this.deps.ownsWorkspace(windowId, request.workspaceId)) {
      return { ok: false, reason: 'not-allowed' }
    }
    const known = portableType(request.path)
    let published = known ? null : this.deps.publishedTables(windowId, request.path)
    if (!known && published === null && request.awaitTables) {
      published = await this.deps.awaitTables(windowId, request.path)
    }
    if (!known && published === null) return { ok: false, reason: 'no-tables' }
    if (published === 'too-large') return { ok: false, reason: 'too-large' }
    const type = known ?? 'tables'
    const confined = this.deps.confine(request.path)
    if (!confined) return { ok: false, reason: 'not-allowed' }
    let file: string
    try {
      file = realpathSync(confined)
    } catch {
      return { ok: false, reason: 'not-allowed' }
    }
    if (runsScripts(type) && this.insideSandbox(file)) {
      return { ok: false, reason: 'sandboxed' }
    }
    const made = published
      ? await this.tables(file, published, request)
      : await this.make(file, type, request)
    if (!made.ok) return made
    if (action === 'publish') return this.publish(file, made.file, request)
    if (action === 'copy') {
      this.deps.writeClipboard(made.file)
      return { ok: true }
    }
    return action === 'open' ? this.open(file, made.file) : this.save(windowId, file, made.file)
  }

  private publish(file: string, text: string, request: PortableRequest): Promise<PortableResult> {
    if (!this.shares || !request.publish) {
      return Promise.resolve({ ok: false, reason: this.shares ? 'bad-options' : 'unavailable' })
    }
    return this.shares.publish({ file: text, source: file, name: basename(file) }, request.publish)
  }

  private insideSandbox(file: string): boolean {
    return this.deps.sandboxedFolders().some((folder) => {
      let real: string
      try {
        real = realpathSync(folder)
      } catch {
        real = folder
      }
      return isInsidePath(real, file)
    })
  }

  async fileFor(file: string, theme: PreviewTheme): Promise<string | null> {
    const type = portableType(file)
    if (!type) return null
    const made = await this.make(file, type, { workspaceId: '', path: file, theme })
    return made.ok ? made.file : null
  }

  private async make(file: string, type: PortableType, request: PortableRequest): Promise<Made> {
    if (runsScripts(type)) {
      const root = this.deps.servesFolder(dirname(file)) ? dirname(file) : null
      const built = await this.deps.builder.build({ file, root }, request.theme, 'production')
      if (built.ok) return { ok: true, file: built.file }
      return { ok: false, reason: 'not-built', message: built.problems.map(problemText).join('\n') }
    }
    const read = await readRegularFile(file, PORTABLE_LIMITS.sourceFileBytes)
    if (!read.ok) return { ok: false, reason: read.status === 413 ? 'too-large' : 'not-allowed' }
    const text = read.body.toString('utf8')
    const page = this.documentFor(type, text, read.body, request.document)
    return this.wrap(file, type, page, request, { [basename(file)]: text })
  }

  private async tables(
    file: string,
    published: ViewerPortableTables,
    request: PortableRequest,
  ): Promise<Made> {
    const regular = await lstat(file).then(
      (stat) => stat.isFile(),
      () => false,
    )
    if (!regular) return { ok: false, reason: 'not-allowed' }
    return this.wrap(file, 'tables', tablesDocument(published), request, {})
  }

  private wrap(
    file: string,
    type: PortableType,
    page: PortableDocument,
    request: PortableRequest,
    sources: Record<string, string>,
  ): Made {
    const name = basename(file)
    const document = documentPage(name, page.body, page.css, request.theme)
    const manifest: PortableManifest = {
      format: PORTABLE_FORMAT,
      type,
      name,
      built: new Date(this.now()).toISOString(),
      ostia: this.deps.version,
      libraries: [],
      theme: request.theme,
      hash: hash('sha256', document),
      sources,
    }
    const wrapped = wrapPortable(document, manifest)
    if (Buffer.byteLength(wrapped) > PORTABLE_LIMITS.fileBytes) {
      return { ok: false, reason: 'too-large' }
    }
    return { ok: true, file: wrapped }
  }

  private documentFor(
    type: PortableType,
    text: string,
    body: Buffer,
    given: PortableDocument | undefined,
  ): PortableDocument {
    if (type === 'svg') {
      return {
        body: `<img alt="" src="data:image/svg+xml;base64,${body.toString('base64')}">`,
        css: IMAGE_CSS,
      }
    }
    if (type === 'json')
      return { body: `<pre>${escapeHtml(prettyJson(text))}</pre>`, css: JSON_CSS }
    return given ?? { body: `<pre>${escapeHtml(text)}</pre>`, css: JSON_CSS }
  }

  private async open(file: string, text: string): Promise<PortableResult> {
    const dir = this.deps.tmpDir()
    const stem = portableFileName(file).replace(/\.html$/, '')
    const target = join(dir, `${stem}-${hash('sha256', text).slice(0, 8)}.html`)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      await writeFile(target, text, { mode: 0o600 })
    } catch (error) {
      return { ok: false, reason: 'failed', message: String(error) }
    }
    const failed = await this.deps.openPath(target)
    return failed ? { ok: false, reason: 'failed', message: failed } : { ok: true }
  }

  private async save(windowId: string, file: string, text: string): Promise<PortableResult> {
    const target = await this.deps.saveDialog(
      windowId,
      join(this.deps.downloads(), portableFileName(file)),
    )
    if (!target) return { ok: false, reason: 'cancelled' }
    try {
      await writeFile(target, text, { mode: 0o644 })
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: 'failed', message: (error as Error).message }
    }
  }

  sweep(): void {
    const dir = this.deps.tmpDir()
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    const cutoff = this.now() - SWEEP_AGE_MS
    for (const name of names) {
      const path = join(dir, name)
      try {
        const st = statSync(path)
        if (st.isFile() && st.mtimeMs < cutoff) rmSync(path)
      } catch {}
    }
  }
}

function portableHandler(exporter: PortableExport, action: PortableAction) {
  return (e: Electron.IpcMainInvokeEvent, value: unknown): Promise<PortableResult> => {
    const request = normalizePortableRequest(value)
    if (!request) return Promise.resolve({ ok: false, reason: 'not-allowed' })
    return exporter.run(String(e.sender.id), action, request)
  }
}

export function registerPortableIpc(exporter: PortableExport): void {
  ipcMain.handle('artifacts:portable-open', portableHandler(exporter, 'open'))
  ipcMain.handle('artifacts:portable-save', portableHandler(exporter, 'save'))
  ipcMain.handle('artifacts:portable-copy', portableHandler(exporter, 'copy'))
  ipcMain.handle('artifacts:portable-publish', portableHandler(exporter, 'publish'))
}
