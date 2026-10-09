import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { LRUCache } from 'lru-cache'
import { findFileLinks, resolveLinkPath } from '../../shared/files/fileLinks'
import type { OpenFileVerdict } from '../../shared/files/openFiles'
import type { FsKind, OpenPathResult } from '../../shared/types'
import type { OpenFileGrants } from '../files/openFileGrants'
import { isProgram } from '../files/openPath'

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
}

export interface TerminalPathLinksDeps {
  output: (paneId: string) => Promise<PaneOutput | null>
  home: string
  grants: Pick<OpenFileGrants, 'admit'>
  pane: (paneId: string) => { windowId: string; workspaceId: string } | undefined
  isSandboxed: (workspaceId: string) => boolean
  isScratch: (workspaceId: string) => boolean
  openFolder: (path: string) => Promise<string>
}

interface Located {
  real: string
  kind: FsKind | null
  mode: number
}

async function locate(path: string): Promise<Located | null> {
  try {
    const real = await realpath(path)
    const found = await stat(real)
    const kind = found.isFile() ? 'file' : found.isDirectory() ? 'dir' : null
    return { real, kind, mode: found.mode }
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

  async openFolder(sender: LinkSender, paneId: unknown, raw: unknown): Promise<OpenPathResult> {
    const path = await this.printedPath(sender, paneId, raw)
    if (!path) return { ok: false, error: 'not-found' }
    const found = await locate(path)
    if (found?.kind !== 'dir') return { ok: false, error: 'not-found' }
    if (isProgram(found.real, found.mode, false)) return { ok: false, error: 'program' }
    const error = await this.deps.openFolder(found.real)
    return error ? { ok: false, error: 'failed' } : { ok: true }
  }

  private async printedPath(
    sender: LinkSender,
    paneId: unknown,
    raw: unknown,
  ): Promise<string | null> {
    const written = pathText(raw)
    if (!written || typeof paneId !== 'string' || !this.allows(sender, paneId)) return null
    const output = await this.deps.output(paneId)
    if (!output || output.remote) return null
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
  ipcMain.handle('terminal-links:open-folder', (e, paneId: unknown, path: unknown) =>
    links.openFolder(e.sender, paneId, path),
  )
}
