import { type ChildProcess, spawn } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { type FSWatcher, mkdirSync, readdirSync, watch } from 'node:fs'
import { join } from 'node:path'
import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import {
  EXTENSION_API_ENV,
  EXTENSION_API_VERSION,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionApi'
import { EXTENSION_LOCALES_DIR } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { kindClaim } from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import { debounce } from 'es-toolkit'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { dropIdentity, setCaps } from '../approvals/capabilityStore'
import { registerExtension, removeExtension } from '../control/idRegistry'
import type { RemoteFolders } from '../files/remoteFolders'
import type { ExtensionAssist } from './extensionAssist'
import { extensionEnvironment } from './extensionEnv'
import type { ExtensionHostDeps } from './extensionHostDeps'
import { type LoadedExtension, newRuntime, type Runtime } from './extensionRuntime'
import type { ExtensionSlots } from './extensionSlots'
import type { ExtensionRecord } from './extensionStore'

export const MAX_RESTARTS = 3

const RESCAN_DEBOUNCE_MS = 250

function startsWithWindow(rt: Runtime): boolean {
  const c = rt.ext.manifest.contributes
  return (
    c.sidebarItems || c.paneChips.length > 0 || c.workspaceChips.length > 0 || c.assist.length > 0
  )
}

function subdirectories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
  } catch {
    return []
  }
}

function manifestSignature(ext: LoadedExtension): string {
  return JSON.stringify([ext.dir, ext.builtin, ext.manifest, ext.catalogs])
}

export interface ExtensionProcessesHost {
  deps: Pick<
    ExtensionHostDeps,
    | 'dataDir'
    | 'exec'
    | 'launches'
    | 'nodePath'
    | 'onCrashed'
    | 'readyTimeoutMs'
    | 'restartDelayMs'
    | 'roots'
    | 'socketPath'
    | 'store'
  >
  runtimes: Map<string, Runtime>
  list(): ExtensionInfo[]
  record(rt: Runtime): ExtensionRecord
  active(rt: Runtime): boolean
  changed(rt?: Runtime): void
  granted(rt: Runtime): Capability[]
  assistant: Pick<ExtensionAssist, 'assistEntries' | 'dropAssistStreams'>
  discover(): LoadedExtension[]
  log(extId: string, line: string): void
  slots: Pick<
    ExtensionSlots,
    | 'clearSidebarOf'
    | 'clearChipsWhere'
    | 'clearWorkspaceChipsWhere'
    | 'clearPanelToolbarsWhere'
    | 'clearInboxWhere'
  >
  remoteFolders: RemoteFolders | null
  changes: EventEmitter
}

export class ExtensionProcesses {
  constructor(private readonly host: ExtensionProcessesHost) {}

  private watchers: FSWatcher[] = []

  private readonly scheduleRescan = debounce(() => this.rescan(), RESCAN_DEBOUNCE_MS)

  private watching = false

  setEnabled(extId: string, enabled: boolean): ExtensionInfo[] {
    const rt = this.host.runtimes.get(extId)
    if (!rt) return this.host.list()
    const record = this.host.record(rt)
    this.host.deps.store.set(extId, { ...record, enabled, approved: record.approved ?? [] })
    rt.restarts = 0
    if (rt.state === 'crashed') rt.state = 'idle'
    if (!enabled) this.stop(rt)
    else if (this.host.active(rt) && rt.proc) rt.restartAfterExit = true
    else if (this.eager(rt)) this.start(rt)
    this.host.changed(rt)
    return this.host.list()
  }

  approve(extId: string): ExtensionInfo[] {
    const rt = this.host.runtimes.get(extId)
    if (!rt) return this.host.list()
    this.host.deps.store.set(extId, {
      ...this.host.record(rt),
      enabled: true,
      approved: [...rt.ext.manifest.capabilities],
      approvedKinds: (rt.ext.manifest.contributes.fileKinds ?? []).map(kindClaim),
    })
    if (rt.identity) setCaps(rt.identity.externalId, this.host.granted(rt))
    if (this.eager(rt)) this.start(rt)
    this.host.changed(rt)
    return this.host.list()
  }

  onDemand(rt: Runtime): boolean {
    if (!rt.ext.builtin) return false
    const c = rt.ext.manifest.contributes
    if (c.assist.length > 0) return this.host.assistant.assistEntries(rt).length === 0
    const chips = c.paneChips.length > 0 || c.workspaceChips.length > 0
    return !chips && !this.host.deps.launches?.has(rt.ext.manifest.id)
  }

  eager(rt: Runtime): boolean {
    return this.host.active(rt) && startsWithWindow(rt) && !this.onDemand(rt)
  }

  isRunning(extId: string): boolean {
    return Boolean(this.host.runtimes.get(extId)?.proc)
  }

  startEager(): void {
    for (const rt of this.host.runtimes.values()) {
      if (this.eager(rt)) this.start(rt)
    }
  }

  rescan(): void {
    const found = new Map(this.host.discover().map((ext) => [ext.manifest.id, ext]))
    let touched = false
    for (const [id, rt] of [...this.host.runtimes]) {
      const next = found.get(id)
      if (!next) {
        this.stop(rt)
        this.host.runtimes.delete(id)
        touched = true
      } else if (manifestSignature(next) !== manifestSignature(rt.ext)) {
        this.replace(rt, next)
        touched = true
      }
    }
    for (const [id, ext] of found) {
      if (this.host.runtimes.has(id)) continue
      const rt = newRuntime(ext)
      this.host.runtimes.set(id, rt)
      if (this.eager(rt)) this.start(rt)
      touched = true
    }
    if (touched) this.host.changed()
    this.watchRoots()
  }

  private replace(rt: Runtime, ext: LoadedExtension): void {
    this.stop(rt)
    rt.ext = ext
    rt.restarts = 0
    rt.state = 'idle'
    if (rt.proc) rt.restartAfterExit = true
    else if (this.eager(rt)) this.start(rt)
  }

  watchUserExtensions(): void {
    for (const root of this.host.deps.roots) {
      if (root.builtin) continue
      try {
        mkdirSync(root.dir, { recursive: true })
      } catch (err) {
        this.host.log('host', `cannot create ${root.dir}: ${(err as Error).message}`)
      }
    }
    this.watching = true
    this.watchRoots()
  }

  private watchRoots(): void {
    if (!this.watching) return
    this.closeWatchers()
    const roots = this.host.deps.roots.filter((r) => !r.builtin).map((r) => r.dir)
    const extensionDirs = roots.flatMap(subdirectories)
    const localeDirs = extensionDirs.map((dir) => join(dir, EXTENSION_LOCALES_DIR))
    const dirs = [...roots, ...extensionDirs, ...localeDirs]
    for (const dir of dirs) {
      try {
        const watcher = watch(dir, () => this.scheduleRescan())
        watcher.on('error', () => this.scheduleRescan())
        this.watchers.push(watcher)
      } catch {}
    }
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
  }

  start(rt: Runtime): void {
    const main = rt.ext.manifest.main
    if (!main || rt.proc || rt.restartTimer || !this.host.active(rt)) return
    const id = rt.ext.manifest.id
    const identity = registerExtension(id)
    setCaps(identity.externalId, this.host.granted(rt))
    const mainPath = join(rt.ext.dir, main)
    const script = /\.(c|m)?js$/.test(main)
    const env = extensionEnvironment(process.env, {
      socket: this.host.deps.socketPath(),
      token: identity.token,
      apiVersion: EXTENSION_API_VERSION,
      apiEnvName: EXTENSION_API_ENV,
      id,
      dir: rt.ext.dir,
      ...(this.host.deps.dataDir ? { dataDir: join(this.host.deps.dataDir, id) } : {}),
    })
    if (script) env.ELECTRON_RUN_AS_NODE = '1'
    rt.identity = identity
    rt.stopping = false
    rt.state = 'starting'
    const proc = spawn(script ? this.host.deps.nodePath : mainPath, script ? [mainPath] : [], {
      cwd: rt.ext.dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    rt.proc = proc
    const pipeLog = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n'))
        if (line.trim()) this.host.log(id, line.slice(0, 500))
    }
    proc.stdout?.on('data', pipeLog)
    proc.stderr?.on('data', pipeLog)
    proc.on('error', (err) => {
      this.host.log(id, `failed to start: ${err.message}`)
      this.onExit(rt, proc)
    })
    proc.on('exit', () => this.onExit(rt, proc))
    this.host.changed(rt)
  }

  private onExit(rt: Runtime, proc: ChildProcess): void {
    if (rt.proc !== proc) return
    const id = rt.ext.manifest.id
    rt.proc = null
    this.revoke(rt)
    rt.ready.clear()
    rt.subscriptions.clear()
    rt.panelOrigins.clear()
    rt.assistStatus = {}
    rt.assistReport = null
    this.host.assistant.dropAssistStreams(rt)
    this.host.slots.clearSidebarOf(id)
    this.host.slots.clearChipsWhere((chip) => chip.extId === id)
    this.host.slots.clearWorkspaceChipsWhere((chip) => chip.extId === id)
    this.host.slots.clearPanelToolbarsWhere((entry) => entry.extId === id)
    this.host.slots.clearInboxWhere((entry) => entry.extId === id)
    this.host.remoteFolders?.extensionGone(id)
    this.host.deps.exec?.stopFor(id)
    if (rt.stopping || !this.host.active(rt)) {
      rt.state = 'idle'
    } else if (rt.restarts < MAX_RESTARTS) {
      rt.restarts += 1
      rt.state = 'starting'
      const delay = (this.host.deps.restartDelayMs ?? 500) * 2 ** (rt.restarts - 1)
      this.host.log(id, `exited; restarting in ${delay}ms (${rt.restarts}/${MAX_RESTARTS})`)
      rt.restartTimer = setTimeout(() => {
        rt.restartTimer = null
        this.start(rt)
      }, delay)
    } else {
      rt.state = 'crashed'
      this.host.log(id, 'exited too often; not restarting')
      this.host.deps.onCrashed?.(id, rt.ext.builtin)
    }
    if (rt.restartAfterExit) {
      rt.restartAfterExit = false
      if (this.host.runtimes.get(id) === rt) this.start(rt)
    }
    this.host.changed(rt)
  }

  private revoke(rt: Runtime): void {
    if (rt.identity) {
      dropIdentity(rt.identity.externalId)
      removeExtension(rt.ext.manifest.id, rt.identity.externalId)
    }
    rt.identity = null
    rt.conn?.dispose()
    rt.conn = null
  }

  private stop(rt: Runtime): void {
    rt.stopping = true
    rt.restartAfterExit = false
    if (rt.restartTimer) clearTimeout(rt.restartTimer)
    rt.restartTimer = null
    this.revoke(rt)
    rt.proc?.kill('SIGTERM')
    if (!rt.proc) rt.state = 'idle'
    rt.assistStatus = {}
    rt.assistReport = null
    this.host.assistant.dropAssistStreams(rt)
    const id = rt.ext.manifest.id
    this.host.slots.clearSidebarOf(id)
    this.host.slots.clearChipsWhere((chip) => chip.extId === id)
    this.host.slots.clearWorkspaceChipsWhere((chip) => chip.extId === id)
    this.host.slots.clearPanelToolbarsWhere((entry) => entry.extId === id)
    this.host.slots.clearInboxWhere((entry) => entry.extId === id)
    this.host.remoteFolders?.extensionGone(id)
    this.host.deps.exec?.stopFor(id)
  }

  recycle(rt: Runtime): void {
    const proc = rt.proc
    this.stop(rt)
    proc?.kill('SIGKILL')
  }

  stopAll(): void {
    this.watching = false
    this.closeWatchers()
    this.scheduleRescan.cancel()
    for (const rt of this.host.runtimes.values()) this.stop(rt)
    this.host.deps.exec?.killAll()
  }

  private waitFor(rt: Runtime, predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve()
    const id = rt.ext.manifest.id
    return new Promise((resolve, reject) => {
      const finish = (err?: Error): void => {
        clearTimeout(timer)
        this.host.changes.off(id, check)
        if (err) reject(err)
        else resolve()
      }
      const check = (): void => {
        if (predicate()) finish()
        else if (rt.state === 'crashed') finish(new Error('extension crashed'))
        else if (!rt.proc && !rt.restartTimer) finish(new Error('extension stopped'))
      }
      const timer = setTimeout(
        () => finish(new Error('extension did not become ready')),
        this.host.deps.readyTimeoutMs ?? 10_000,
      )
      this.host.changes.on(id, check)
    })
  }

  async connected(rt: Runtime, command?: string): Promise<MessageConnection> {
    if (rt.state === 'crashed') throw new Error('extension crashed')
    if (!rt.ext.manifest.main) throw new Error('extension has no process')
    if (rt.proc && rt.stopping) rt.restartAfterExit = true
    this.start(rt)
    await this.waitFor(rt, () =>
      Boolean(rt.conn && (command === undefined || rt.ready.has(command))),
    )
    if (!rt.conn) throw new Error('extension disconnected')
    return rt.conn
  }

  reloadRecords(): void {
    for (const rt of this.host.runtimes.values()) {
      if (!this.host.active(rt)) {
        if (rt.proc || rt.restartTimer) this.stop(rt)
      } else {
        if (rt.identity) setCaps(rt.identity.externalId, this.host.granted(rt))
        if (this.eager(rt)) this.start(rt)
      }
    }
    this.host.changed()
  }
}
