import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { type FSWatcher, mkdirSync, readdirSync, watch } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { ALL_CAPABILITIES, type Capability } from '../shared/capabilities'
import {
  DIFF_TEXT_MAX,
  EXTENSION_EVENT_TYPES,
  EXTENSION_ICONS,
  type ExtensionCaller,
  type ExtensionCommandContribution,
  type ExtensionEventPayloads,
  type ExtensionEventType,
  type ExtensionIcon,
  type ExtensionInfo,
  type ExtensionOpenDiffRequest,
  type ExtensionOpenPanelRequest,
  type ExtensionPanelContext,
  type ExtensionPanelSource,
  type ExtensionResult,
  type ExtensionSettingResult,
  type ExtensionSettingValues,
  type ExtensionSidebarItem,
  type ExtensionStatus,
  PANE_CHIP_TEXT_MAX,
  PANE_CHIP_TOOLTIP_MAX,
  type PaneChip,
  SETTINGS_CHANGED_EVENT,
  SIDEBAR_TONES,
  type SidebarTone,
  TERMINAL_ARG_MAX,
  TERMINAL_COMMAND_MAX_ARGS,
  TERMINAL_TITLE_MAX,
  commandArgument,
  effectiveSettingValues,
  panelPath,
  sidebarItemUrl,
  validSettingValue,
} from '../shared/extensions'
import { quoteArgv } from '../shared/shellQuote'
import type { Workflow } from '../shared/workflows'
import { dropIdentity, hasCap, setCaps } from './capabilityStore'
import { registerControlMethod } from './controlServer'
import {
  type DiscoveredExtension,
  type ExtensionRoot,
  discoverExtensions,
  isInsideDir,
  parseCommand,
} from './extensionManifest'
import { type ExtensionStore, effectiveRecord, grantedCaps, needsApproval } from './extensionStore'
import {
  type PaneIdentity,
  registerExtension,
  removeExtension,
  resolveExternal,
} from './idRegistry'

export const MAX_RESTARTS = 3
export const REQUEST_TIMEOUT_MS = 30_000
export const INTERACTIVE_TIMEOUT_MS = 10 * 60_000
const MAX_SIDEBAR_ITEMS = 32
const SIDEBAR_TEXT_MAX = 80
const DIFF_TITLE_MAX = 200
const DIFF_LANGUAGE_MAX = 40
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])
const RESCAN_DEBOUNCE_MS = 250

type RunState = 'idle' | 'starting' | 'running' | 'crashed'

interface Runtime {
  ext: DiscoveredExtension
  proc: ChildProcess | null
  identity: PaneIdentity | null
  conn: MessageConnection | null
  ready: Map<string, ExtensionCommandContribution>
  subscriptions: Set<ExtensionEventType>
  state: RunState
  restarts: number
  restartTimer: ReturnType<typeof setTimeout> | null
  stopping: boolean
  restartAfterExit: boolean
  panelOrigins: Set<string>
}

function newRuntime(ext: DiscoveredExtension): Runtime {
  return {
    ext,
    proc: null,
    identity: null,
    conn: null,
    ready: new Map(),
    subscriptions: new Set(),
    state: 'idle',
    restarts: 0,
    restartTimer: null,
    stopping: false,
    restartAfterExit: false,
    panelOrigins: new Set(),
  }
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function storedSettings(raw: unknown): Map<string, ExtensionSettingValues> {
  const out = new Map<string, ExtensionSettingValues>()
  if (!isPlainRecord(raw)) return out
  for (const [extId, values] of Object.entries(raw)) {
    if (!isPlainRecord(values)) continue
    const kept: ExtensionSettingValues = {}
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'string' || typeof value === 'boolean') kept[key] = value
      else if (typeof value === 'number' && Number.isFinite(value)) kept[key] = value
    }
    out.set(extId, kept)
  }
  return out
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

function manifestSignature(ext: DiscoveredExtension): string {
  return JSON.stringify([ext.dir, ext.builtin, ext.manifest])
}

export interface ExtensionHostDeps {
  roots: ExtensionRoot[]
  store: ExtensionStore
  socketPath: () => string
  nodePath: string
  workDirForWorkspace: (workspaceId?: string) => string | undefined
  cwdForPane?: (paneId: string) => string | undefined
  locale?: () => string | undefined
  broadcast: (channel: string, payload: unknown) => void
  openPanelIn: (req: ExtensionOpenPanelRequest) => void
  openDiffIn?: (req: ExtensionOpenDiffRequest) => void
  openTerminalIn?: (req: TerminalOpenRequest) => Promise<string | null>
  notify: (n: { title: string; body?: string; from: string }) => void
  restartDelayMs?: number
  readyTimeoutMs?: number
  requestTimeoutMs?: number
  interactiveTimeoutMs?: number
  log?: (extId: string, line: string) => void
  readExtensionSettings?: () => unknown
  confirm?: (req: ExtensionConfirmRequest) => Promise<boolean>
  notifyPanel?: (
    n: { title: string; body?: string; from: string; extId: string; panelPath?: string },
    openPanel: () => void,
  ) => void
}

export interface TerminalOpenRequest {
  command: string
  workspaceId?: string
  windowId?: string
  afterPaneId?: string
  cwd?: string
  title?: string
}

export interface ExtensionConfirmRequest {
  extId: string
  extName: string
  title: string
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
}

const CONFIRM_TITLE_MAX = 120
const CONFIRM_MESSAGE_MAX = 500
const CONFIRM_DETAIL_MAX = 2000
const CONFIRM_LABEL_MAX = 40
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function terminalArgv(raw: unknown): string[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'command must be a non-empty array'
  if (raw.length > TERMINAL_COMMAND_MAX_ARGS) {
    return `command is limited to ${TERMINAL_COMMAND_MAX_ARGS} arguments`
  }
  for (const arg of raw) {
    if (typeof arg !== 'string') return 'command arguments must be strings'
    if (arg.length > TERMINAL_ARG_MAX)
      return `arguments are limited to ${TERMINAL_ARG_MAX} characters`
    if (hasControlChar(arg)) return 'command arguments must not contain control characters'
  }
  if (!raw[0]) return 'command must start with a program'
  return raw as string[]
}

function fail(error: string, message?: string): ExtensionResult {
  return message ? { ok: false, error, message } : { ok: false, error }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

function normalizeResult(raw: unknown): ExtensionResult {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as { ok?: unknown }).ok === 'boolean'
  ) {
    const r = raw as {
      ok: boolean
      error?: unknown
      message?: unknown
      text?: unknown
      data?: unknown
    }
    if (!r.ok) {
      const failed = fail(
        typeof r.error === 'string' ? r.error : 'failed',
        typeof r.message === 'string' ? r.message : undefined,
      )
      return r.data === undefined ? failed : { ...failed, data: r.data }
    }
    const out: ExtensionResult = { ok: true }
    if (typeof r.text === 'string') out.text = r.text
    if (r.data !== undefined) out.data = r.data
    return out
  }
  return raw === undefined || raw === null ? { ok: true } : { ok: true, data: raw }
}

export function capsOf(externalId: string): Capability[] {
  return ALL_CAPABILITIES.filter((cap) => hasCap(externalId, cap))
}

export function loopbackOrigin(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' || !LOOPBACK_HOSTS.has(u.hostname)) return null
    return u.origin
  } catch {
    return null
  }
}

export class ExtensionHost {
  private runtimes = new Map<string, Runtime>()
  private sidebar = new Map<string, ExtensionSidebarItem>()
  private chips = new Map<string, PaneChip>()
  private settings: Map<string, ExtensionSettingValues>
  private changes = new EventEmitter()
  private watchers: FSWatcher[] = []
  private rescanTimer: ReturnType<typeof setTimeout> | null = null
  private watching = false

  constructor(private readonly deps: ExtensionHostDeps) {
    this.changes.setMaxListeners(0)
    for (const ext of this.discover()) this.runtimes.set(ext.manifest.id, newRuntime(ext))
    this.settings = storedSettings(deps.readExtensionSettings?.())
  }

  private discover(): DiscoveredExtension[] {
    return discoverExtensions(this.deps.roots, (dir, error) => this.log(dir, error))
  }

  private log(extId: string, line: string): void {
    ;(this.deps.log ?? ((id, l) => console.error(`[ext:${id}] ${l}`)))(extId, line)
  }

  private record(rt: Runtime) {
    return effectiveRecord(rt.ext.builtin, this.deps.store.get(rt.ext.manifest.id))
  }

  private pending(rt: Runtime): boolean {
    return needsApproval(rt.ext.builtin, this.deps.store.get(rt.ext.manifest.id))
  }

  private active(rt: Runtime): boolean {
    return !this.pending(rt) && this.record(rt).enabled
  }

  private granted(rt: Runtime): Capability[] {
    return grantedCaps(rt.ext.manifest.capabilities, this.record(rt).approved)
  }

  private status(rt: Runtime): ExtensionStatus {
    if (this.pending(rt)) return 'pending-approval'
    if (!this.record(rt).enabled) return 'disabled'
    return rt.state
  }

  paletteArgs(extId: string, command: string, argument: unknown): { argv: string[] } | null {
    const rt = this.runtimes.get(extId)
    const cmd = rt ? this.commandsOf(rt).find((c) => c.id === command) : undefined
    const value = cmd?.argument ? commandArgument(argument) : null
    return value ? { argv: [value] } : null
  }

  private commandsOf(rt: Runtime): ExtensionCommandContribution[] {
    const declared = rt.ext.manifest.contributes.commands
    const dynamic = [...rt.ready.values()].filter((c) => !declared.some((d) => d.id === c.id))
    return [...declared, ...dynamic]
  }

  private info(rt: Runtime): ExtensionInfo {
    const m = rt.ext.manifest
    const granted = this.granted(rt)
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      builtin: rt.ext.builtin,
      enabled: this.active(rt),
      status: this.status(rt),
      requested: m.capabilities,
      granted,
      unapproved: m.capabilities.filter((c) => !granted.includes(c)),
      commands: this.commandsOf(rt),
      panel: m.contributes.panel
        ? { title: m.contributes.panel.title, icon: m.contributes.panel.icon }
        : null,
      paneChips: m.contributes.paneChips,
      settings: m.contributes.settings,
      settingValues: this.settingValues(rt),
    }
  }

  private settingValues(rt: Runtime): ExtensionSettingValues {
    return effectiveSettingValues(
      rt.ext.manifest.contributes.settings,
      this.settings.get(rt.ext.manifest.id),
    )
  }

  list(): ExtensionInfo[] {
    return [...this.runtimes.values()].map((rt) => this.info(rt))
  }

  workflows(): { extId: string; workflows: Workflow[] }[] {
    return [...this.runtimes.values()]
      .filter((rt) => this.active(rt) && rt.ext.manifest.contributes.workflows)
      .map((rt) => ({
        extId: rt.ext.manifest.id,
        workflows: rt.ext.manifest.contributes.workflows ?? [],
      }))
  }

  completionDirs(): string[] {
    return [...this.runtimes.values()]
      .filter((rt) => this.active(rt) && rt.ext.manifest.contributes.completions)
      .map((rt) => join(rt.ext.dir, rt.ext.manifest.contributes.completions ?? ''))
  }

  sidebarItems(): ExtensionSidebarItem[] {
    return [...this.sidebar.values()]
  }

  paneChips(): PaneChip[] {
    return [...this.chips.values()]
  }

  private chipsChanged(): void {
    this.deps.broadcast('extensions:chips', this.paneChips())
  }

  private clearChipsWhere(match: (chip: PaneChip) => boolean): void {
    let removed = false
    for (const [slot, chip] of this.chips) {
      if (match(chip)) {
        this.chips.delete(slot)
        removed = true
      }
    }
    if (removed) this.chipsChanged()
  }

  clearPaneChips(rendererPaneId: string): void {
    this.clearChipsWhere((chip) => chip.paneId === rendererPaneId)
  }

  private changed(rt?: Runtime): void {
    if (rt) this.changes.emit(rt.ext.manifest.id)
    this.deps.broadcast('extensions:changed', this.list())
  }

  private sidebarChanged(): void {
    this.deps.broadcast('extensions:sidebar', this.sidebarItems())
  }

  setEnabled(extId: string, enabled: boolean): ExtensionInfo[] {
    const rt = this.runtimes.get(extId)
    if (!rt) return this.list()
    this.deps.store.set(extId, { enabled, approved: this.record(rt).approved ?? [] })
    rt.restarts = 0
    if (rt.state === 'crashed') rt.state = 'idle'
    if (!enabled) this.stop(rt)
    else if (this.active(rt) && rt.proc) rt.restartAfterExit = true
    else if (this.eager(rt)) this.start(rt)
    this.changed(rt)
    return this.list()
  }

  approve(extId: string): ExtensionInfo[] {
    const rt = this.runtimes.get(extId)
    if (!rt) return this.list()
    this.deps.store.set(extId, { enabled: true, approved: [...rt.ext.manifest.capabilities] })
    if (rt.identity) setCaps(rt.identity.externalId, this.granted(rt))
    if (rt.ext.manifest.contributes.sidebarItems) this.start(rt)
    this.changed(rt)
    return this.list()
  }

  private eager(rt: Runtime): boolean {
    return this.active(rt) && rt.ext.manifest.contributes.sidebarItems
  }

  startEager(): void {
    for (const rt of this.runtimes.values()) {
      if (this.eager(rt)) this.start(rt)
    }
  }

  rescan(): void {
    const found = new Map(this.discover().map((ext) => [ext.manifest.id, ext]))
    let touched = false
    for (const [id, rt] of [...this.runtimes]) {
      const next = found.get(id)
      if (!next) {
        this.stop(rt)
        this.runtimes.delete(id)
        touched = true
      } else if (manifestSignature(next) !== manifestSignature(rt.ext)) {
        this.replace(rt, next)
        touched = true
      }
    }
    for (const [id, ext] of found) {
      if (this.runtimes.has(id)) continue
      const rt = newRuntime(ext)
      this.runtimes.set(id, rt)
      if (this.eager(rt)) this.start(rt)
      touched = true
    }
    if (touched) this.changed()
    this.watchRoots()
  }

  private replace(rt: Runtime, ext: DiscoveredExtension): void {
    this.stop(rt)
    rt.ext = ext
    rt.restarts = 0
    rt.state = 'idle'
    if (rt.proc) rt.restartAfterExit = true
    else if (this.eager(rt)) this.start(rt)
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null
      this.rescan()
    }, RESCAN_DEBOUNCE_MS)
  }

  watchUserExtensions(): void {
    for (const root of this.deps.roots) {
      if (root.builtin) continue
      try {
        mkdirSync(root.dir, { recursive: true })
      } catch (err) {
        this.log('host', `cannot create ${root.dir}: ${(err as Error).message}`)
      }
    }
    this.watching = true
    this.watchRoots()
  }

  private watchRoots(): void {
    if (!this.watching) return
    this.closeWatchers()
    const roots = this.deps.roots.filter((r) => !r.builtin).map((r) => r.dir)
    const dirs = [...roots, ...roots.flatMap(subdirectories)]
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

  private start(rt: Runtime): void {
    const main = rt.ext.manifest.main
    if (!main || rt.proc || rt.restartTimer || !this.active(rt)) return
    const id = rt.ext.manifest.id
    const identity = registerExtension(id)
    setCaps(identity.externalId, this.granted(rt))
    const mainPath = join(rt.ext.dir, main)
    const script = /\.(c|m)?js$/.test(main)
    const { PINE_PANE_ID: _pane, PINE_START_DIR: _workspace, ...inherited } = process.env
    const env: NodeJS.ProcessEnv = {
      ...inherited,
      PINE_SOCKET: this.deps.socketPath(),
      PINE_TOKEN: identity.token,
      PINE_EXTENSION_ID: id,
      PINE_EXTENSION_DIR: rt.ext.dir,
    }
    if (script) env.ELECTRON_RUN_AS_NODE = '1'
    rt.identity = identity
    rt.stopping = false
    rt.state = 'starting'
    const proc = spawn(script ? this.deps.nodePath : mainPath, script ? [mainPath] : [], {
      cwd: rt.ext.dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    rt.proc = proc
    const pipeLog = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n'))
        if (line.trim()) this.log(id, line.slice(0, 500))
    }
    proc.stdout?.on('data', pipeLog)
    proc.stderr?.on('data', pipeLog)
    proc.on('error', (err) => {
      this.log(id, `failed to start: ${err.message}`)
      this.onExit(rt, proc)
    })
    proc.on('exit', () => this.onExit(rt, proc))
    this.changed(rt)
  }

  private clearSidebarOf(extId: string): void {
    let removed = false
    for (const [key, item] of this.sidebar) {
      if (item.extId === extId) {
        this.sidebar.delete(key)
        removed = true
      }
    }
    if (removed) this.sidebarChanged()
  }

  private onExit(rt: Runtime, proc: ChildProcess): void {
    if (rt.proc !== proc) return
    const id = rt.ext.manifest.id
    rt.proc = null
    this.revoke(rt)
    rt.ready.clear()
    rt.subscriptions.clear()
    rt.panelOrigins.clear()
    this.clearSidebarOf(id)
    this.clearChipsWhere((chip) => chip.extId === id)
    if (rt.stopping || !this.active(rt)) {
      rt.state = 'idle'
    } else if (rt.restarts < MAX_RESTARTS) {
      rt.restarts += 1
      rt.state = 'starting'
      const delay = (this.deps.restartDelayMs ?? 500) * 2 ** (rt.restarts - 1)
      this.log(id, `exited; restarting in ${delay}ms (${rt.restarts}/${MAX_RESTARTS})`)
      rt.restartTimer = setTimeout(() => {
        rt.restartTimer = null
        this.start(rt)
      }, delay)
    } else {
      rt.state = 'crashed'
      this.log(id, 'exited too often; not restarting')
    }
    if (rt.restartAfterExit) {
      rt.restartAfterExit = false
      if (this.runtimes.get(id) === rt) this.start(rt)
    }
    this.changed(rt)
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
    const id = rt.ext.manifest.id
    this.clearSidebarOf(id)
    this.clearChipsWhere((chip) => chip.extId === id)
  }

  stopAll(): void {
    this.watching = false
    this.closeWatchers()
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.rescanTimer = null
    for (const rt of this.runtimes.values()) this.stop(rt)
  }

  private waitFor(rt: Runtime, predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve()
    const id = rt.ext.manifest.id
    return new Promise((resolve, reject) => {
      const finish = (err?: Error): void => {
        clearTimeout(timer)
        this.changes.off(id, check)
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
        this.deps.readyTimeoutMs ?? 10_000,
      )
      this.changes.on(id, check)
    })
  }

  private async connected(rt: Runtime, command?: string): Promise<MessageConnection> {
    if (rt.state === 'crashed') throw new Error('extension crashed')
    if (!rt.ext.manifest.main) throw new Error('extension has no process')
    this.start(rt)
    await this.waitFor(rt, () =>
      Boolean(rt.conn && (command === undefined || rt.ready.has(command))),
    )
    if (!rt.conn) throw new Error('extension disconnected')
    return rt.conn
  }

  async invoke(
    extId: string,
    command: string,
    args: unknown,
    caller: ExtensionCaller,
  ): Promise<ExtensionResult> {
    const rt = this.runtimes.get(extId)
    if (!rt) return fail('unknown-extension', `no extension '${extId}'`)
    if (!this.active(rt)) return fail('extension-disabled', `extension '${extId}' is not enabled`)
    const cmd = this.commandsOf(rt).find((c) => c.id === command)
    if (!cmd) return fail('unknown-command', `'${extId}' has no command '${command}'`)
    const missing = cmd.capabilities.find((cap) => !caller.capabilities.includes(cap))
    if (missing) return fail('needs-elevation', missing)
    try {
      const conn = await this.connected(rt, command)
      const timeoutMs = cmd.interactive
        ? (this.deps.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS)
        : (this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
      const raw = await withTimeout(
        conn.sendRequest('ext.command', { command, args: args ?? null, caller }),
        timeoutMs,
        `${extId} ${command}`,
      )
      return normalizeResult(raw)
    } catch (err) {
      return fail('extension-unavailable', (err as Error).message)
    }
  }

  userCaller(workspaceId: string | null, extra: Partial<ExtensionCaller> = {}): ExtensionCaller {
    const caller: ExtensionCaller = { kind: 'user', capabilities: [...ALL_CAPABILITIES], ...extra }
    if (workspaceId) {
      caller.workspaceId = workspaceId
      const workDir = this.deps.workDirForWorkspace(workspaceId)
      if (workDir) caller.workDir = workDir
    }
    return caller
  }

  paneCaller(identity: PaneIdentity): ExtensionCaller {
    const caller: ExtensionCaller = {
      kind: 'pane',
      paneId: identity.externalId,
      workspaceId: identity.workspaceId,
      capabilities: capsOf(identity.externalId),
    }
    const workDir = this.deps.workDirForWorkspace(identity.workspaceId)
    if (workDir) caller.workDir = workDir
    const cwd = this.deps.cwdForPane?.(identity.paneId)
    if (cwd) caller.cwd = cwd
    const locale = this.deps.locale?.()
    if (locale) caller.locale = locale
    return caller
  }

  commandCapabilities(extId: string, command: string): Capability[] {
    const rt = this.runtimes.get(extId)
    return rt ? (this.commandsOf(rt).find((c) => c.id === command)?.capabilities ?? []) : []
  }

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
    const rt = this.runtimes.get(extId)
    if (!rt || !this.active(rt)) return { ok: false, error: 'extension-disabled' }
    const panel = rt.ext.manifest.contributes.panel
    if (!panel) return { ok: false, error: 'no-panel' }
    const path = context.path === undefined ? null : panelPath(context.path)
    if (context.path !== undefined && !path) return { ok: false, error: 'invalid-panel-path' }
    if (panel.entry !== 'url') {
      if (rt.ext.manifest.main) this.start(rt)
      const src = this.filePanelUrl(rt, panel.entry, path)
      return src ? { ok: true, src } : { ok: false, error: 'panel-url-not-allowed' }
    }
    try {
      const conn = await this.connected(rt)
      const caller = this.userCaller(context.workspaceId, { locale: context.locale })
      const res = await withTimeout(
        conn.sendRequest<{ url?: unknown }>('ext.panel', path ? { caller, path } : { caller }),
        this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
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
    const rt = this.runtimes.get(extId)
    const panel = rt?.ext.manifest.contributes.panel
    if (!rt || !panel || !this.active(rt)) return false
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

  panelExtensionIds(): string[] {
    return [...this.runtimes.values()]
      .filter((rt) => rt.ext.manifest.contributes.panel)
      .map((rt) => rt.ext.manifest.id)
  }

  emitEvent<T extends ExtensionEventType>(type: T, payload: ExtensionEventPayloads[T]): void {
    for (const rt of this.runtimes.values()) {
      if (rt.conn && rt.subscriptions.has(type)) {
        void rt.conn.sendNotification('ext.event', { type, payload }).catch(() => {})
      }
    }
  }

  private runtimeOf(identity: PaneIdentity, conn: MessageConnection): Runtime {
    const rt = identity.extId ? this.runtimes.get(identity.extId) : undefined
    if (!rt || rt.identity?.externalId !== identity.externalId) throw new Error('stale extension')
    if (rt.conn !== conn) {
      rt.conn = conn
      rt.state = 'running'
      this.changed(rt)
    }
    return rt
  }

  registerCommands(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const raw = (params as { commands?: unknown })?.commands
    if (!Array.isArray(raw)) return fail('invalid-params', 'commands must be an array')
    const declared = rt.ext.manifest.contributes.commands
    for (const [i, entry] of raw.entries()) {
      const id = typeof entry === 'string' ? entry : (entry as { id?: unknown })?.id
      const known = declared.find((c) => c.id === id)
      if (known) {
        rt.ready.set(known.id, known)
        continue
      }
      if (typeof entry === 'string') return fail('undeclared-command', `'${entry}' needs a title`)
      const parsed = parseCommand(entry, i)
      if (typeof parsed === 'string') return fail('invalid-command', parsed)
      rt.ready.set(parsed.id, parsed)
    }
    this.changed(rt)
    return { ok: true, commands: [...rt.ready.keys()] }
  }

  subscribe(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const events = (params as { events?: unknown })?.events
    if (!Array.isArray(events)) return fail('invalid-params', 'events must be an array')
    for (const type of events) {
      if (!EXTENSION_EVENT_TYPES.includes(type as ExtensionEventType)) {
        return fail('unknown-event', String(type))
      }
      const cap: Capability = type === 'notification' ? 'notify' : 'read-board'
      if (!hasCap(identity.externalId, cap)) return fail('needs-elevation', cap)
    }
    for (const type of events) rt.subscriptions.add(type as ExtensionEventType)
    return { ok: true, events: [...rt.subscriptions] }
  }

  setSidebarItem(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const extId = rt.ext.manifest.id
    if (!rt.ext.manifest.contributes.sidebarItems) {
      return fail('not-contributed', 'manifest does not contribute sidebarItems')
    }
    const p = (params ?? {}) as Record<string, unknown>
    const key = typeof p.key === 'string' && p.key ? p.key.slice(0, 40) : 'default'
    const workspaceId =
      typeof p.workspaceId === 'string' && p.workspaceId ? p.workspaceId : undefined
    const slot = `${extId}\u0000${workspaceId ?? ''}\u0000${key}`
    const text = typeof p.text === 'string' ? p.text.trim().slice(0, SIDEBAR_TEXT_MAX) : ''
    if (!text) {
      if (this.sidebar.delete(slot)) this.sidebarChanged()
      return { ok: true }
    }
    const count = [...this.sidebar.values()].filter((i) => i.extId === extId).length
    if (!this.sidebar.has(slot) && count >= MAX_SIDEBAR_ITEMS) return fail('too-many-items')
    const tone = SIDEBAR_TONES.includes(p.tone as SidebarTone) ? (p.tone as SidebarTone) : 'neutral'
    const item: ExtensionSidebarItem = { extId, key, text, tone }
    if (workspaceId) item.workspaceId = workspaceId
    if (EXTENSION_ICONS.includes(p.icon as ExtensionIcon)) item.icon = p.icon as ExtensionIcon
    const url = sidebarItemUrl(p.url)
    if (url) item.url = url
    this.sidebar.set(slot, item)
    this.sidebarChanged()
    return { ok: true }
  }

  setPaneChip(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const extId = rt.ext.manifest.id
    const p = (params ?? {}) as Record<string, unknown>
    const declared = rt.ext.manifest.contributes.paneChips.find((c) => c.id === p.id)
    if (!declared) return fail('not-contributed', `no pane chip '${String(p.id)}' in manifest`)
    const pane = typeof p.paneId === 'string' ? resolveExternal(p.paneId) : undefined
    if (pane?.kind !== 'pane') return fail('unknown-pane', 'paneId is not a pane')
    const slot = `${extId}\u0000${pane.paneId}\u0000${declared.id}`
    const text = typeof p.text === 'string' ? p.text.trim().slice(0, PANE_CHIP_TEXT_MAX) : ''
    if (!text) {
      if (this.chips.delete(slot)) this.chipsChanged()
      return { ok: true }
    }
    const tone = SIDEBAR_TONES.includes(p.tone as SidebarTone) ? (p.tone as SidebarTone) : 'neutral'
    const chip: PaneChip = { extId, id: declared.id, paneId: pane.paneId, text, tone }
    if (typeof p.tooltip === 'string' && p.tooltip.trim()) {
      chip.tooltip = p.tooltip.trim().slice(0, PANE_CHIP_TOOLTIP_MAX)
    }
    if (p.command !== undefined && p.url !== undefined) {
      return fail('invalid-params', 'a chip has either a command or a url')
    }
    if (p.command !== undefined) {
      const command = this.commandsOf(rt).find((c) => c.id === p.command && c.palette)
      if (!command) return fail('invalid-params', 'command must be one of your palette commands')
      chip.command = command.id
    }
    if (p.url !== undefined) {
      const url = sidebarItemUrl(p.url)
      if (!url) return fail('invalid-params', 'url must be http(s)')
      chip.url = url
    }
    this.chips.set(slot, chip)
    this.chipsChanged()
    return { ok: true }
  }

  clearPaneChip(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const p = (params ?? {}) as Record<string, unknown>
    return this.setPaneChip(identity, conn, { paneId: p.paneId, id: p.id, text: '' })
  }

  getSettings(identity: PaneIdentity, conn: MessageConnection) {
    const rt = this.runtimeOf(identity, conn)
    return { ok: true, values: this.settingValues(rt) }
  }

  private sendSettings(rt: Runtime): void {
    if (!rt.conn || rt.ext.manifest.contributes.settings.length === 0) return
    const payload = { values: this.settingValues(rt) }
    void rt.conn
      .sendNotification('ext.event', { type: SETTINGS_CHANGED_EVENT, payload })
      .catch(() => {})
  }

  setSetting(extId: string, key: string, value: unknown): ExtensionSettingResult {
    const rt = this.runtimes.get(extId)
    if (!rt) return { ok: false, error: 'unknown-extension' }
    const setting = rt.ext.manifest.contributes.settings.find((s) => s.key === key)
    if (!setting) return { ok: false, error: 'unknown-setting' }
    const stored: ExtensionSettingValues = { ...(this.settings.get(extId) ?? {}) }
    if (value === null) delete stored[key]
    else if (validSettingValue(setting, value)) stored[key] = value
    else return { ok: false, error: 'invalid-value' }
    this.settings.set(extId, stored)
    this.sendSettings(rt)
    this.changed(rt)
    return { ok: true, stored, list: this.list() }
  }

  reloadSettings(): void {
    const before = new Map(
      [...this.runtimes].map(([id, rt]) => [id, JSON.stringify(this.settingValues(rt))]),
    )
    this.settings = storedSettings(this.deps.readExtensionSettings?.())
    for (const [id, rt] of this.runtimes) {
      if (before.get(id) !== JSON.stringify(this.settingValues(rt))) this.sendSettings(rt)
    }
    this.changed()
  }

  notify(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
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
    if (wantsPanel && rt.ext.manifest.contributes.panel && this.deps.notifyPanel) {
      const req: ExtensionOpenPanelRequest = { extId: rt.ext.manifest.id }
      if (path) req.path = path
      const n = path
        ? { title, body, from, extId: req.extId, panelPath: path }
        : { title, body, from, extId: req.extId }
      this.deps.notifyPanel(n, () => this.deps.openPanelIn(req))
    } else {
      this.deps.notify({ title, body, from })
    }
    return { ok: true }
  }

  openPanel(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    if (!rt.ext.manifest.contributes.panel) return fail('not-contributed', 'no panel in manifest')
    const p = (params ?? {}) as { workspaceId?: unknown; path?: unknown }
    const req: ExtensionOpenPanelRequest = { extId: rt.ext.manifest.id }
    if (typeof p.workspaceId === 'string' && p.workspaceId) req.workspaceId = p.workspaceId
    if (p.path !== undefined) {
      const path = panelPath(p.path)
      if (!path) return fail('invalid-params', "path must start with '/'")
      req.path = path
    }
    this.deps.openPanelIn(req)
    return { ok: true }
  }

  openDiff(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
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
    if (!this.deps.openDiffIn) return fail('no-window')
    this.deps.openDiffIn(req)
    return { ok: true }
  }

  async openTerminal(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    this.runtimeOf(identity, conn)
    const p = (params ?? {}) as Record<string, unknown>
    const argv = terminalArgv(p.command)
    if (typeof argv === 'string') return fail('invalid-params', argv)
    const req: TerminalOpenRequest = { command: quoteArgv(argv) }
    const workspaceId =
      typeof p.workspaceId === 'string' && p.workspaceId ? p.workspaceId : undefined
    if (p.afterPaneId !== undefined) {
      const after = typeof p.afterPaneId === 'string' ? resolveExternal(p.afterPaneId) : undefined
      if (after?.kind !== 'pane') return fail('unknown-pane', 'afterPaneId is not a pane')
      if (workspaceId && workspaceId !== after.workspaceId) {
        return fail('invalid-params', 'afterPaneId is not in that workspace')
      }
      req.afterPaneId = after.paneId
      req.workspaceId = after.workspaceId
      req.windowId = after.windowId
    } else if (workspaceId) {
      req.workspaceId = workspaceId
    }
    if (p.cwd !== undefined) {
      if (typeof p.cwd !== 'string' || !isAbsolute(p.cwd)) {
        return fail('invalid-params', 'cwd must be absolute')
      }
      req.cwd = p.cwd
    }
    if (typeof p.title === 'string' && p.title.trim()) {
      req.title = p.title.trim().slice(0, TERMINAL_TITLE_MAX)
    }
    if (!this.deps.openTerminalIn) return fail('no-window')
    const paneId = await this.deps.openTerminalIn(req)
    return paneId ? { ok: true, paneId } : fail('not-opened', 'no workspace to open it in')
  }

  listForAgents() {
    return this.list()
      .filter((e) => e.enabled)
      .map((e) => ({ id: e.id, name: e.name, status: e.status, commands: e.commands }))
  }

  async confirm(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const p = (params ?? {}) as Record<string, unknown>
    const text = (v: unknown, max: number): string =>
      typeof v === 'string' ? v.trim().slice(0, max) : ''
    const title = text(p.title, CONFIRM_TITLE_MAX)
    const message = text(p.message, CONFIRM_MESSAGE_MAX)
    if (!title || !message) return fail('invalid-params', 'title and message are required')
    if (!this.deps.confirm) return fail('no-window')
    const req: ExtensionConfirmRequest = {
      extId: rt.ext.manifest.id,
      extName: rt.ext.manifest.name,
      title,
      message,
    }
    const detail = text(p.detail, CONFIRM_DETAIL_MAX)
    if (detail) req.detail = detail
    const confirmLabel = text(p.confirmLabel, CONFIRM_LABEL_MAX)
    if (confirmLabel) req.confirmLabel = confirmLabel
    const cancelLabel = text(p.cancelLabel, CONFIRM_LABEL_MAX)
    if (cancelLabel) req.cancelLabel = cancelLabel
    return { ok: true, confirmed: await this.deps.confirm(req) }
  }

  reloadRecords(): void {
    for (const rt of this.runtimes.values()) {
      if (!this.active(rt)) {
        if (rt.proc || rt.restartTimer) this.stop(rt)
      } else {
        if (rt.identity) setCaps(rt.identity.externalId, this.granted(rt))
        if (rt.ext.manifest.contributes.sidebarItems) this.start(rt)
      }
    }
    this.changed()
  }
}

export function registerExtensionMethods(host: () => ExtensionHost | null): void {
  const forExtension = (
    fn: (
      h: ExtensionHost,
      identity: PaneIdentity,
      conn: MessageConnection,
      params: unknown,
    ) => unknown,
  ) => ({
    callers: 'extensions' as const,
    handler: (params: unknown, ctx: { identity: PaneIdentity; conn: MessageConnection }) => {
      const h = host()
      if (!h) return fail('no-extension-host')
      return fn(h, ctx.identity, ctx.conn, params)
    },
  })

  registerControlMethod(
    'ext.registerCommands',
    forExtension((h, id, conn, p) => h.registerCommands(id, conn, p)),
  )
  registerControlMethod(
    'ext.subscribe',
    forExtension((h, id, conn, p) => h.subscribe(id, conn, p)),
  )
  registerControlMethod(
    'ext.setSidebarItem',
    forExtension((h, id, conn, p) => h.setSidebarItem(id, conn, p)),
  )
  registerControlMethod('ext.notify', {
    ...forExtension((h, id, conn, p) => h.notify(id, conn, p)),
    cap: 'notify',
  })
  registerControlMethod(
    'ext.openPanel',
    forExtension((h, id, conn, p) => h.openPanel(id, conn, p)),
  )
  registerControlMethod(
    'ext.setPaneChip',
    forExtension((h, id, conn, p) => h.setPaneChip(id, conn, p)),
  )
  registerControlMethod(
    'ext.clearPaneChip',
    forExtension((h, id, conn, p) => h.clearPaneChip(id, conn, p)),
  )
  registerControlMethod(
    'ext.getSettings',
    forExtension((h, id, conn) => h.getSettings(id, conn)),
  )

  registerControlMethod(
    'ext.openDiff',
    forExtension((h, id, conn, p) => h.openDiff(id, conn, p)),
  )

  registerControlMethod('ext.openTerminal', {
    ...forExtension((h, id, conn, p) => h.openTerminal(id, conn, p)),
    cap: 'shell',
  })

  registerControlMethod('ext.list', {
    handler: () => host()?.listForAgents() ?? [],
  })

  registerControlMethod('ext.invoke', {
    handler: (params, ctx) => {
      const h = host()
      if (!h) return fail('no-extension-host')
      const p = (params ?? {}) as { extId?: unknown; command?: unknown; args?: unknown }
      if (typeof p.extId !== 'string' || typeof p.command !== 'string') {
        return fail('invalid-params', 'extId and command are required')
      }
      return h.invoke(p.extId, p.command, p.args, h.paneCaller(ctx.identity))
    },
  })

  registerControlMethod(
    'ext.confirm',
    forExtension((h, id, conn, p) => h.confirm(id, conn, p)),
  )
}
