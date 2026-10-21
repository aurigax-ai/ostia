import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  type ExtensionCaller,
  panelPath,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type {
  ExtensionPanelContext,
  ExtensionPanelSource,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import { type KindRoles, kindMatches } from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import { isInsideDir } from '@aurigax-ai/ostia-extension-sdk/manifest/confinedRead'
import type { ExtensionHostDeps } from './extensionHostDeps'
import type { ExtensionProcesses } from './extensionProcesses'
import { REQUEST_TIMEOUT_MS, type Runtime, withTimeout } from './extensionRuntime'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])

export function loopbackOrigin(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' || !LOOPBACK_HOSTS.has(u.hostname)) return null
    return u.origin
  } catch {
    return null
  }
}

export interface ExtensionPanelsHost {
  deps: Pick<ExtensionHostDeps, 'requestTimeoutMs'>
  runtimes: ReadonlyMap<string, Runtime>
  active(rt: Runtime): boolean
  kindApproved(rt: Runtime, kind: KindRoles): boolean
  processes: Pick<ExtensionProcesses, 'connected' | 'start'>
  userCaller(workspaceId: string | null, extra?: Partial<ExtensionCaller>): ExtensionCaller
}

export class ExtensionPanels {
  constructor(private readonly host: ExtensionPanelsHost) {}

  private filePanelUrl(rt: Runtime, entry: string, path: string | null): string | null {
    if (!path) return pathToFileURL(join(rt.ext.dir, entry)).href
    const cut = path.search(/[?#]/)
    const pathname = cut === -1 ? path : path.slice(0, cut)
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return null
    }
    const url = pathToFileURL(join(rt.ext.dir, decoded)).href
    const full = cut === -1 ? url : url + path.slice(cut)
    return this.isAllowedPanelUrl(rt.ext.manifest.id, full) ? full : null
  }

  async resolvePanel(extId: string, context: ExtensionPanelContext): Promise<ExtensionPanelSource> {
    const rt = this.host.runtimes.get(extId)
    if (!rt || !this.host.active(rt)) return { ok: false, error: 'extension-disabled' }
    const panel = rt.ext.manifest.contributes.panel
    if (!panel) return { ok: false, error: 'no-panel' }
    const path = context.path === undefined ? null : panelPath(context.path)
    if (context.path !== undefined && !path) return { ok: false, error: 'invalid-panel-path' }
    if (panel.entry !== 'url') {
      if (rt.ext.manifest.main) this.host.processes.start(rt)
      const src = this.filePanelUrl(rt, panel.entry, path)
      return src ? { ok: true, src } : { ok: false, error: 'panel-url-not-allowed' }
    }
    try {
      const conn = await this.host.processes.connected(rt)
      const caller = this.host.userCaller(context.workspaceId, { locale: context.locale })
      if (context.workspaceId) rt.callerWorkspaces.add(context.workspaceId)
      const res = await withTimeout(
        conn.sendRequest<{ url?: unknown }>('ext.panel', path ? { caller, path } : { caller }),
        this.host.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        `${extId} panel`,
      )
      const url = typeof res?.url === 'string' ? res.url : ''
      const origin = loopbackOrigin(url)
      if (!origin) return { ok: false, error: 'panel-url-not-loopback' }
      rt.panelOrigins.add(origin)
      return { ok: true, src: url }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  isAllowedPanelUrl(extId: string, url: string): boolean {
    const rt = this.host.runtimes.get(extId)
    const panel = rt?.ext.manifest.contributes.panel
    if (!rt || !panel || !this.host.active(rt)) return false
    if (panel.entry !== 'url') {
      try {
        const u = new URL(url)
        return u.protocol === 'file:' && isInsideDir(rt.ext.dir, fileURLToPath(u))
      } catch {
        return false
      }
    }
    const origin = loopbackOrigin(url)
    return origin !== null && rt.panelOrigins.has(origin)
  }

  viewSource(
    extId: string,
    kindId: string,
    path: string,
  ): { dir: string; entry: string; builtin: boolean } | null {
    const rt = this.host.runtimes.get(extId)
    if (!rt || !this.host.active(rt)) return null
    const kind = rt.ext.manifest.contributes.fileKinds?.find((k) => k.id === kindId)
    if (!kind?.view || !kindMatches(path, kind) || !this.host.kindApproved(rt, kind)) return null
    return { dir: rt.ext.dir, entry: kind.view.entry, builtin: rt.ext.builtin }
  }

  hasViewKind(path: string): boolean {
    return [...this.host.runtimes.values()].some(
      (rt) =>
        this.host.active(rt) &&
        (rt.ext.manifest.contributes.fileKinds ?? []).some(
          (kind) => kind.view && kindMatches(path, kind) && this.host.kindApproved(rt, kind),
        ),
    )
  }

  panelExtensionIds(): string[] {
    return [...this.host.runtimes.values()]
      .filter((rt) => rt.ext.manifest.contributes.panel)
      .map((rt) => rt.ext.manifest.id)
  }
}
