import type { Stats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { LRUCache } from 'lru-cache'
import { findFileLinks, resolveLinkPath } from '../../shared/files/fileLinks'
import type { OpenFileVerdict } from '../../shared/files/openFiles'
import type { FsKind, OpenPathResult } from '../../shared/files/filesApi'
import type { OpenFileGrants } from '../files/openFileGrants'
import { openUnlessProgram } from '../files/openPath'

const PROBE_TTL_MS = 5_000
const PROBE_CACHE_MAX = 500
const PROBE_RATE_WINDOW_MS = 1_000
export const PROBE_RATE_MAX = 40
const PROBE_CALLERS_MAX = 64
const PATH_MAX = 4096

export interface LinkSender {
  id: number
  getType: () => string
}

export interface PaneOutput {
  text: string
  cwd: string | null
  remote: boolean
  sandboxed: boolean
}

export interface TerminalPathLinksDeps {
  output: (paneId: string) => Promise<PaneOutput | null>
  home: string
  grants: Pick<OpenFileGrants, 'admit'>
  pane: (paneId: string) => { windowId: string; workspaceId: string } | undefined
  isSandboxed: (workspaceId: string) => boolean
  isScratch: (workspaceId: string) => boolean
  openPath: (path: string) => Promise<string>
  showInFolder: (path: string) => void
}

interface Located {
  real: string
  kind: FsKind | null
  info: Stats
}

async function locate(path: string): Promise<Located | null> {
  try {
    const real = await realpath(path)
    const found = await stat(real)
    const kind = found.isFile() ? 'file' : found.isDirectory() ? 'dir' : null
    return { real, kind, info: found }
  } catch {
    return null
  }
}

function pathText(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length <= PATH_MAX && !raw.includes('\0') ? raw : null
}

function underHome(path: string): boolean {
  return path === '~' || path.startsWith('~/')
}

export class TerminalPathLinks {
  private readonly kinds = new LRUCache<string, Promise<FsKind | null>>({
    ttl: PROBE_TTL_MS,
    max: PROBE_CACHE_MAX,
  })
  private readonly asked = new LRUCache<number, number>({
    ttl: PROBE_RATE_WINDOW_MS,
    max: PROBE_CALLERS_MAX,
    noUpdateTTL: true,
  })

  constructor(private readonly deps: TerminalPathLinksDeps) {}

  async probe(sender: LinkSender, paneId: unknown, raw: unknown): Promise<FsKind | null> {
    const path = await this.printedPath(sender, paneId, raw)
    if (!path) return null
    const cached = this.kinds.get(path)
    if (cached) return cached
    if (!this.withinRate(sender.id)) return null
    const kind = locate(path).then((found) => found?.kind ?? null)
    this.kinds.set(path, kind)
    return kind
  }

  async admit(sender: LinkSender, paneId: unknown, raw: unknown): Promise<OpenFileVerdict | null> {
    const path = await this.printedPath(sender, paneId, raw)
    if (!path) return null
    return this.deps.grants.admit(path, { sandboxed: false, remember: true })
  }

  async openDefault(sender: LinkSender, paneId: unknown, raw: unknown): Promise<OpenPathResult> {
    const found = await this.printedTarget(sender, paneId, raw)
    if (!found) return { ok: false, error: 'not-found' }
    return openUnlessProgram(found.real, found.info, this.deps.openPath)
  }

  async showInFolder(sender: LinkSender, paneId: unknown, raw: unknown): Promise<OpenPathResult> {
    const found = await this.printedTarget(sender, paneId, raw)
    if (!found) return { ok: false, error: 'not-found' }
    this.deps.showInFolder(found.real)
    return { ok: true }
  }

  private async printedTarget(
    sender: LinkSender,
    paneId: unknown,
    raw: unknown,
  ): Promise<Located | null> {
    const path = await this.printedPath(sender, paneId, raw)
    const found = path ? await locate(path) : null
    return found?.kind ? found : null
  }

  private async printedPath(
    sender: LinkSender,
    paneId: unknown,
    raw: unknown,
  ): Promise<string | null> {
    const written = pathText(raw)
    if (!written || typeof paneId !== 'string' || !this.allows(sender, paneId)) return null
    const output = await this.deps.output(paneId)
    if (!output || output.remote || output.sandboxed) return null
    if (!findFileLinks(output.text).some((link) => link.path === written)) return null
    const anchored = written.startsWith('/') || underHome(written)
    if (!anchored && output.cwd === null) return null
    const resolved = resolveLinkPath(written, output.cwd ?? '/')
    return underHome(resolved) ? join(this.deps.home, resolved.slice(1)) : resolved
  }

  private allows(sender: LinkSender, paneId: unknown): boolean {
    if (sender.getType() !== 'window' || typeof paneId !== 'string') return false
    const pane = this.deps.pane(paneId)
    if (!pane || pane.windowId !== String(sender.id)) return false
    return !this.deps.isSandboxed(pane.workspaceId) && !this.deps.isScratch(pane.workspaceId)
  }

  private withinRate(senderId: number): boolean {
    const count = this.asked.get(senderId) ?? 0
    if (count >= PROBE_RATE_MAX) return false
    this.asked.set(senderId, count + 1)
    return true
  }
}

export function registerTerminalPathLinkIpc(links: TerminalPathLinks): void {
  ipcMain.handle('terminal-links:probe', (e, paneId: unknown, path: unknown) =>
    links.probe(e.sender, paneId, path),
  )
  ipcMain.handle('terminal-links:admit', (e, paneId: unknown, path: unknown) =>
    links.admit(e.sender, paneId, path),
  )
  ipcMain.handle('terminal-links:open-default', (e, paneId: unknown, path: unknown) =>
    links.openDefault(e.sender, paneId, path),
  )
  ipcMain.handle('terminal-links:show-in-folder', (e, paneId: unknown, path: unknown) =>
    links.showInFolder(e.sender, paneId, path),
  )
}
