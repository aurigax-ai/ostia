import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { type FSWatcher, mkdirSync, readdirSync, watch } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { agentSkillId, hookAgentsFor } from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import { appEnv, withoutEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import type { AssistOpenUiRequest } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import {
  ALL_CAPABILITIES,
  type Capability,
} from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import {
  EXTENSION_API_ENV,
  EXTENSION_API_VERSION,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionApi'
import {
  EXTENSION_BASE_LOCALE,
  EXTENSION_LOCALES_DIR,
  type ExtensionLocaleChangedPayload,
  LOCALE_CHANGED_EVENT,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import {
  EXTENSION_EVENT_TYPES,
  EXTENSION_REDACT_TEXTS_MAX,
  EXTENSION_REDACT_TEXT_MAX,
  type ExtensionAgentOffer,
  type ExtensionCaller,
  type ExtensionCommandContribution,
  type ExtensionEventPayloads,
  type ExtensionEventType,
  type ExtensionInfo,
  type ExtensionManifest,
  type ExtensionOpenDiffRequest,
  type ExtensionOpenFileRequest,
  type ExtensionOpenPanelRequest,
  type ExtensionPanelContext,
  type ExtensionPanelSource,
  type ExtensionResult,
  type ExtensionStatus,
  type WorkspaceChip,
  commandArgument,
  panelPath,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { languageServerSummary } from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import {
  FOLDER_CLOSED_EVENT,
  type RemoteCwd,
  type RemoteFilesRequest,
  type RemoteFolder,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { isInsideDir } from '@aurigax-ai/ostia-extension-sdk/manifest/confinedRead'
import {
  type ExtensionRoot,
  discoverExtensions,
  parseCommand,
} from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import {
  loadLocaleCatalogs,
  manifestIn,
} from '@aurigax-ai/ostia-extension-sdk/manifest/localeCatalogs'
import { debounce } from 'es-toolkit'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { RedactionResult } from '../../shared/privacy/redaction'
import type { AgentOfferDelivery, HeldResume } from '../agents/extensionAgents'
import { dropIdentity, hasCap, setCaps } from '../approvals/capabilityStore'
import { registerControlMethod } from '../control/controlServer'
import { type PaneIdentity, registerExtension, removeExtension } from '../control/idRegistry'
import {
  REMOTE_REQUEST_TIMEOUT_MS,
  RemoteFolders,
  type RemoteFoldersDeps,
} from '../files/remoteFolders'
import { ExtensionAssist } from './extensionAssist'
import { ExtensionConfig } from './extensionConfig'
import type { ExtensionConnections } from './extensionConnections'
import { ExtensionContributions } from './extensionContributions'
import type { ExtensionExec } from './extensionExec'
import type { ExtensionLaunches } from './extensionLaunches'
import {
  type ExtensionConfirmRequest,
  ExtensionRuns,
  type TerminalOpenRequest,
} from './extensionRuns'
import {
  type LoadedExtension,
  type Runtime,
  fail,
  isPlainRecord,
  withTimeout,
} from './extensionRuntime'
import { ExtensionSlots } from './extensionSlots'
import { type ExtensionStore, effectiveRecord, grantedCaps, needsApproval } from './extensionStore'
import { ExtensionWindowRequests } from './extensionWindowRequests'

export const MAX_RESTARTS = 3
const REQUEST_TIMEOUT_MS = 30_000
const INTERACTIVE_TIMEOUT_MS = 10 * 60_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])
const RESCAN_DEBOUNCE_MS = 250

function newRuntime(ext: LoadedExtension): Runtime {
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
    assistStatus: {},
    assistReport: null,
    offering: false,
    reached: new Set(),
    opened: new Set(),
    callerWorkspaces: new Set(),
  }
}

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

export interface ExtensionHostDeps {
  roots: ExtensionRoot[]
  store: ExtensionStore
  launches?: ExtensionLaunches
  socketPath: () => string
  nodePath: string
  dataDir?: string
  workDirForWorkspace: (workspaceId?: string) => string | undefined
  cwdForPane?: (paneId: string) => string | undefined
  locale?: () => string | undefined
  broadcast: (channel: string, payload: unknown) => void
  onChanged?: () => void
  publishWorkspaceChips?: (chips: WorkspaceChip[]) => void
  openPanelIn: (req: ExtensionOpenPanelRequest) => void
  openDiffIn?: (req: ExtensionOpenDiffRequest) => void
  openFileIn?: (req: ExtensionOpenFileRequest) => Promise<ExtensionResult>
  openTerminalIn?: (req: TerminalOpenRequest) => Promise<string | null>
  notify: (n: { title: string; body?: string; from: string }) => void
  restartDelayMs?: number
  readyTimeoutMs?: number
  requestTimeoutMs?: number
  interactiveTimeoutMs?: number
  log?: (extId: string, line: string) => void
  onCrashed?: (extId: string, builtin: boolean) => void
  readExtensionSettings?: () => unknown
  readAssistSettings?: () => { assistant?: unknown } | null
  assistKeys?: ExtensionSecretStore
  redact?: (text: string) => Promise<RedactionResult>
  assistTimeoutMs?: number
  openAssistUiIn?: (req: AssistOpenUiRequest) => void
  assistChatTimeoutMs?: number
  assistModelsTimeoutMs?: number
  secrets?: ExtensionSecretStore
  connections?: ExtensionConnections
  confirm?: (req: ExtensionConfirmRequest) => Promise<boolean>
  isSandboxed?: (workspaceId: string) => boolean
  sandboxDomains?: (workspaceId: string) => string[] | null
  hostGrants?: {
    offer: (extId: string, command: string) => void
    claim: (extId: string, command: string) => string | null
  }
  notifyPanel?: (
    n: { title: string; body?: string; from: string; extId: string; panelPath?: string },
    openPanel: () => void,
  ) => void
  agentArgv?: (name: string) => string[] | null
  agentNames?: () => string[]
  offerToAgentIn?: (offer: Omit<ExtensionAgentOffer, 'requestId'>) => Promise<AgentOfferDelivery>
  focusPaneIn?: (pane: PaneIdentity) => boolean
  exec?: ExtensionExec
  resumeOf?: (pane: PaneIdentity) => Promise<HeldResume | null>
  agentTaskClock?: () => number
  remoteCwdForPane?: (paneId: string) => RemoteCwd | undefined
  agentRunning?: (paneId: string) => boolean
  remoteFolders?: Pick<RemoteFoldersDeps, 'windowOfWorkspace' | 'refusal' | 'confirm'> & {
    publish: (folders: RemoteFolders) => void
  }
}
export interface ExtensionSecretStore {
  keys: (extId: string) => string[]
  get: (extId: string, key: string) => string | null
  set: (
    extId: string,
    key: string,
    value: string | null,
  ) => { ok: true } | { ok: false; error: string }
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

function capsOf(externalId: string): Capability[] {
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
  private changes = new EventEmitter()
  private watchers: FSWatcher[] = []
  private readonly scheduleRescan = debounce(() => this.rescan(), RESCAN_DEBOUNCE_MS)
  private watching = false
  private announcedLocale: string
  readonly remoteFolders: RemoteFolders | null
  readonly assistant: ExtensionAssist
  readonly slots: ExtensionSlots
  readonly runs: ExtensionRuns
  readonly contributions: ExtensionContributions
  readonly config: ExtensionConfig
  readonly windowRequests: ExtensionWindowRequests

  constructor(private readonly deps: ExtensionHostDeps) {
    this.changes.setMaxListeners(0)
    for (const ext of this.discover()) this.runtimes.set(ext.manifest.id, newRuntime(ext))
    this.config = new ExtensionConfig({
      deps,
      runtimes: this.runtimes,
      runtimeOf: (identity, conn) => this.runtimeOf(identity, conn),
      changed: (rt) => this.changed(rt),
      list: () => this.list(),
      reloadAssistSettings: () => this.assistant.reloadAssistSettings(),
    })
    this.contributions = new ExtensionContributions({
      deps,
      runtimes: this.runtimes,
      active: (rt) => this.active(rt),
      pending: (rt) => this.pending(rt),
      record: (rt) => this.record(rt),
      granted: (rt) => this.granted(rt),
      settingValues: (rt) => this.config.settingValues(rt),
      eager: (rt) => this.eager(rt),
      start: (rt) => this.start(rt),
      changed: (rt) => this.changed(rt),
    })
    this.runs = new ExtensionRuns({
      deps,
      runtimes: this.runtimes,
      runtimeOf: (identity, conn) => this.runtimeOf(identity, conn),
      shownName: (rt) => this.shownName(rt),
      active: (rt) => this.active(rt),
      granted: (rt) => this.granted(rt),
    })
    this.slots = new ExtensionSlots({
      deps,
      runtimeOf: (identity, conn) => this.runtimeOf(identity, conn),
      commandsOf: (rt) => this.commandsOf(rt),
    })
    this.assistant = new ExtensionAssist({
      deps,
      runtimes: this.runtimes,
      active: (rt) => this.active(rt),
      granted: (rt) => this.granted(rt),
      shownName: (rt) => this.shownName(rt),
      runtimeOf: (identity, conn) => this.runtimeOf(identity, conn),
      onDemand: (rt) => this.onDemand(rt),
      eager: (rt) => this.eager(rt),
      start: (rt) => this.start(rt),
      settingValues: (rt) => this.config.settingValues(rt),
    })
    this.announcedLocale = this.currentLocale()
    this.remoteFolders = this.createRemoteFolders()
    this.windowRequests = new ExtensionWindowRequests({
      deps,
      remoteFolders: this.remoteFolders,
      runtimeOf: (identity, conn) => this.runtimeOf(identity, conn),
      shownName: (rt) => this.shownName(rt),
    })
  }

  private discover(): LoadedExtension[] {
    return discoverExtensions(this.deps.roots, (dir, error) => this.log(dir, error)).map((ext) => ({
      ...ext,
      catalogs: loadLocaleCatalogs(ext.dir, ext.manifest, (problem) =>
        this.log(ext.manifest.id, problem),
      ),
    }))
  }

  private manifestIn(rt: Runtime, locale: string | undefined): ExtensionManifest {
    return manifestIn(rt.ext.manifest, rt.ext.catalogs, locale)
  }

  displayName(extId: string): string {
    const rt = this.runtimes.get(extId)
    return rt ? this.shownName(rt) : extId
  }

  private shownName(rt: Runtime): string {
    return this.manifestIn(rt, this.deps.locale?.()).name
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

  private commandsOf(
    rt: Runtime,
    declared: ExtensionCommandContribution[] = rt.ext.manifest.contributes.commands,
  ): ExtensionCommandContribution[] {
    const dynamic = [...rt.ready.values()].filter((c) => !declared.some((d) => d.id === c.id))
    return [...declared, ...dynamic]
  }

  private info(rt: Runtime, locale: string | undefined): ExtensionInfo {
    const m = this.manifestIn(rt, locale)
    const granted = this.granted(rt)
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      category: m.category,
      builtin: rt.ext.builtin,
      enabled: this.active(rt),
      status: this.status(rt),
      requested: m.capabilities,
      granted,
      unapproved: m.capabilities.filter((c) => !granted.includes(c)),
      commands: this.commandsOf(rt, m.contributes.commands),
      panel: m.contributes.panel
        ? { title: m.contributes.panel.title, icon: m.contributes.panel.icon }
        : null,
      paneChips: m.contributes.paneChips,
      workspaceChips: m.contributes.workspaceChips,
      settings: m.contributes.settings,
      settingValues: this.config.settingValues(rt),
      settingsPage: this.active(rt) ? (m.contributes.settingsPage ?? null) : null,
      assist: m.contributes.assist,
      secrets: m.contributes.secrets,
      secretsSet: (this.deps.secrets?.keys(m.id) ?? []).filter((key) =>
        m.contributes.secrets.some((s) => s.key === key),
      ),
      connectionKinds: m.contributes.connections ?? [],
      iconThemes: (m.contributes.iconThemes ?? []).map(({ id, label }) => ({ id, label })),
      languages: (m.contributes.languages ?? []).map(({ id, label }) => ({ id, label })),
      keymaps: (m.contributes.keymaps ?? []).map(({ id, label, platform }) => ({
        id,
        label,
        ...(platform ? { platform } : {}),
      })),
      languageServers: (m.contributes.languageServers ?? []).map(languageServerSummary),
      agentSkills: (m.contributes.agentSkills ?? []).map((skill) => agentSkillId(m.id, skill.name)),
      agentHooks: (m.contributes.agentHooks ?? []).map((hook) => ({
        ...hook,
        agents: hookAgentsFor(hook.event),
      })),
      ...(m.contributes.verb ? { verb: m.contributes.verb } : {}),
    }
  }

  list(): ExtensionInfo[] {
    return this.listIn(this.deps.locale?.())
  }

  private listIn(locale: string | undefined): ExtensionInfo[] {
    return [...this.runtimes.values()].map((rt) => this.info(rt, locale))
  }

  private currentLocale(): string {
    return this.deps.locale?.() ?? EXTENSION_BASE_LOCALE
  }

  refreshLocale(): void {
    const locale = this.currentLocale()
    if (locale === this.announcedLocale) return
    this.announcedLocale = locale
    const payload: ExtensionLocaleChangedPayload = { locale }
    for (const rt of this.runtimes.values()) {
      void rt.conn
        ?.sendNotification('ext.event', { type: LOCALE_CHANGED_EVENT, payload })
        .catch(() => {})
    }
    this.changed()
  }

  getLocale(identity: PaneIdentity, conn: MessageConnection) {
    this.runtimeOf(identity, conn)
    return { ok: true, locale: this.currentLocale() }
  }

  private changed(rt?: Runtime): void {
    if (rt) this.changes.emit(rt.ext.manifest.id)
    this.deps.broadcast('extensions:changed', this.list())
    this.assistant.assistChanged()
    this.deps.onChanged?.()
  }

  setEnabled(extId: string, enabled: boolean): ExtensionInfo[] {
    const rt = this.runtimes.get(extId)
    if (!rt) return this.list()
    const record = this.record(rt)
    this.deps.store.set(extId, { ...record, enabled, approved: record.approved ?? [] })
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
    this.deps.store.set(extId, {
      ...this.record(rt),
      enabled: true,
      approved: [...rt.ext.manifest.capabilities],
    })
    if (rt.identity) setCaps(rt.identity.externalId, this.granted(rt))
    if (this.eager(rt)) this.start(rt)
    this.changed(rt)
    return this.list()
  }

  private onDemand(rt: Runtime): boolean {
    if (!rt.ext.builtin) return false
    const c = rt.ext.manifest.contributes
    if (c.assist.length > 0) return this.assistant.assistEntries(rt).length === 0
    const chips = c.paneChips.length > 0 || c.workspaceChips.length > 0
    return !chips && !this.deps.launches?.has(rt.ext.manifest.id)
  }

  private eager(rt: Runtime): boolean {
    return this.active(rt) && startsWithWindow(rt) && !this.onDemand(rt)
  }

  isRunning(extId: string): boolean {
    return Boolean(this.runtimes.get(extId)?.proc)
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

  private replace(rt: Runtime, ext: LoadedExtension): void {
    this.stop(rt)
    rt.ext = ext
    rt.restarts = 0
    rt.state = 'idle'
    if (rt.proc) rt.restartAfterExit = true
    else if (this.eager(rt)) this.start(rt)
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

  private start(rt: Runtime): void {
    const main = rt.ext.manifest.main
    if (!main || rt.proc || rt.restartTimer || !this.active(rt)) return
    const id = rt.ext.manifest.id
    const identity = registerExtension(id)
    setCaps(identity.externalId, this.granted(rt))
    const mainPath = join(rt.ext.dir, main)
    const script = /\.(c|m)?js$/.test(main)
    const env: NodeJS.ProcessEnv = {
      ...withoutEnv(process.env, ['PANE_ID', 'START_DIR']),
      ...appEnv({
        SOCKET: this.deps.socketPath(),
        TOKEN: identity.token,
        [EXTENSION_API_ENV]: EXTENSION_API_VERSION,
        EXTENSION_ID: id,
        EXTENSION_DIR: rt.ext.dir,
        ...(this.deps.dataDir ? { EXTENSION_DATA: join(this.deps.dataDir, id) } : {}),
      }),
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
    this.assistant.dropAssistStreams(rt)
    this.slots.clearSidebarOf(id)
    this.slots.clearChipsWhere((chip) => chip.extId === id)
    this.slots.clearWorkspaceChipsWhere((chip) => chip.extId === id)
    this.remoteFolders?.extensionGone(id)
    this.deps.exec?.stopFor(id)
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
      this.deps.onCrashed?.(id, rt.ext.builtin)
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
    rt.assistStatus = {}
    rt.assistReport = null
    this.assistant.dropAssistStreams(rt)
    const id = rt.ext.manifest.id
    this.slots.clearSidebarOf(id)
    this.slots.clearChipsWhere((chip) => chip.extId === id)
    this.slots.clearWorkspaceChipsWhere((chip) => chip.extId === id)
    this.remoteFolders?.extensionGone(id)
    this.deps.exec?.stopFor(id)
  }

  stopAll(): void {
    this.watching = false
    this.closeWatchers()
    this.scheduleRescan.cancel()
    for (const rt of this.runtimes.values()) this.stop(rt)
    this.deps.exec?.killAll()
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
    if (rt.proc && rt.stopping) rt.restartAfterExit = true
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
    if (caller.workspaceId) rt.callerWorkspaces.add(caller.workspaceId)
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
      if (this.deps.isSandboxed?.(workspaceId)) caller.sandboxed = true
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
    if (this.deps.isSandboxed?.(identity.workspaceId)) caller.sandboxed = true
    if (identity.manager) caller.manager = true
    if (this.deps.agentRunning?.(identity.paneId)) caller.agentRunning = true
    const remote = this.deps.remoteCwdForPane?.(identity.paneId)
    if (remote) caller.remote = remote
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
      if (context.workspaceId) rt.callerWorkspaces.add(context.workspaceId)
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

  workspaceClosed(workspaceId: string): void {
    for (const rt of this.runtimes.values()) rt.callerWorkspaces.delete(workspaceId)
    this.emitEvent('workspace.closed', { workspaceId })
  }

  sandboxDomains(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const workspaceId = isPlainRecord(params) ? params.workspaceId : undefined
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return fail('invalid-params', 'workspaceId is required')
    }
    if (!rt.callerWorkspaces.has(workspaceId)) {
      return fail('not-reached', 'only a workspace this extension has a caller in')
    }
    const domains = this.deps.sandboxDomains?.(workspaceId)
    if (!domains) return fail('not-sandboxed', 'the workspace is not sandboxed')
    return { ok: true, domains: [...domains] }
  }

  emitEvent<T extends ExtensionEventType>(type: T, payload: ExtensionEventPayloads[T]): void {
    this.runs.settleTerminalWait(type, payload)
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

  startWithWindow(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const on = (params as { on?: unknown } | null)?.on
    if (typeof on !== 'boolean') return fail('invalid-params', 'on must be a boolean')
    this.deps.launches?.set(rt.ext.manifest.id, on)
    return { ok: true }
  }

  openedBy(identity: PaneIdentity, paneId: string): boolean {
    const extId = identity.kind === 'extension' ? identity.extId : undefined
    const rt = extId ? this.runtimes.get(extId) : undefined
    return rt?.identity?.externalId === identity.externalId && rt.opened.has(paneId)
  }

  async redactTexts(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    this.runtimeOf(identity, conn)
    const texts = isPlainRecord(params) ? params.texts : undefined
    if (
      !Array.isArray(texts) ||
      texts.length > EXTENSION_REDACT_TEXTS_MAX ||
      !texts.every(
        (t): t is string => typeof t === 'string' && t.length <= EXTENSION_REDACT_TEXT_MAX,
      )
    ) {
      return fail(
        'invalid-params',
        `texts must be at most ${EXTENSION_REDACT_TEXTS_MAX} strings of at most ${EXTENSION_REDACT_TEXT_MAX} characters`,
      )
    }
    const redact = this.deps.redact
    if (!redact) return fail('redaction-failed')
    try {
      const results = await Promise.all(texts.map((text) => redact(text)))
      return { ok: true, texts: results.map((result) => result.text) }
    } catch {
      return fail('redaction-failed')
    }
  }

  listForAgents() {
    return this.listIn(undefined)
      .filter((e) => e.enabled)
      .map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        ...(e.verb ? { verb: e.verb } : {}),
        commands: e.commands,
      }))
  }

  private createRemoteFolders(): RemoteFolders | null {
    const deps = this.deps.remoteFolders
    if (!deps) return null
    const folders: RemoteFolders = new RemoteFolders({
      windowOfWorkspace: deps.windowOfWorkspace,
      refusal: deps.refusal,
      confirm: deps.confirm,
      publish: () => deps.publish(folders),
      request: (extId, req) => this.filesRequest(extId, req),
      closed: (folder) => this.folderClosed(folder),
    })
    return folders
  }

  private filesRequest(extId: string, req: RemoteFilesRequest): Promise<unknown> {
    const rt = this.runtimes.get(extId)
    if (!rt?.conn || !this.active(rt)) return Promise.reject(new Error('extension stopped'))
    return withTimeout(
      rt.conn.sendRequest('ext.files', req),
      this.deps.requestTimeoutMs ?? REMOTE_REQUEST_TIMEOUT_MS,
      `${extId} files`,
    )
  }

  private folderClosed(folder: RemoteFolder): void {
    const rt = this.runtimes.get(folder.extId)
    void rt?.conn
      ?.sendNotification('ext.event', {
        type: FOLDER_CLOSED_EVENT,
        payload: { folderId: folder.id },
      })
      .catch(() => {})
  }

  reloadRecords(): void {
    for (const rt of this.runtimes.values()) {
      if (!this.active(rt)) {
        if (rt.proc || rt.restartTimer) this.stop(rt)
      } else {
        if (rt.identity) setCaps(rt.identity.externalId, this.granted(rt))
        if (this.eager(rt)) this.start(rt)
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
    'ext.startWithWindow',
    forExtension((h, id, conn, p) => h.startWithWindow(id, conn, p)),
  )
  registerControlMethod(
    'ext.setSidebarItem',
    forExtension((h, id, conn, p) => h.slots.setSidebarItem(id, conn, p)),
  )
  registerControlMethod('ext.notify', {
    ...forExtension((h, id, conn, p) => h.windowRequests.notify(id, conn, p)),
    cap: 'notify',
  })
  registerControlMethod(
    'ext.openPanel',
    forExtension((h, id, conn, p) => h.windowRequests.openPanel(id, conn, p)),
  )
  registerControlMethod(
    'ext.setPaneChip',
    forExtension((h, id, conn, p) => h.slots.setPaneChip(id, conn, p)),
  )
  registerControlMethod(
    'ext.clearPaneChip',
    forExtension((h, id, conn, p) => h.slots.clearPaneChip(id, conn, p)),
  )
  registerControlMethod(
    'ext.setWorkspaceChip',
    forExtension((h, id, conn, p) => h.slots.setWorkspaceChip(id, conn, p)),
  )
  registerControlMethod(
    'ext.clearWorkspaceChip',
    forExtension((h, id, conn, p) => h.slots.clearWorkspaceChip(id, conn, p)),
  )
  registerControlMethod(
    'ext.getSettings',
    forExtension((h, id, conn) => h.config.getSettings(id, conn)),
  )
  registerControlMethod(
    'ext.setSetting',
    forExtension((h, id, conn, p) => h.config.setOwnSetting(id, conn, p)),
  )

  registerControlMethod(
    'ext.openDiff',
    forExtension((h, id, conn, p) => h.windowRequests.openDiff(id, conn, p)),
  )

  registerControlMethod(
    'ext.openFile',
    forExtension((h, id, conn, p) => h.windowRequests.openFile(id, conn, p)),
  )

  registerControlMethod('ext.openTerminal', {
    ...forExtension((h, id, conn, p) => h.runs.openTerminal(id, conn, p)),
    cap: 'shell',
  })

  registerControlMethod('ext.agents', {
    ...forExtension((h, id, conn) => h.runs.agentNames(id, conn)),
    cap: 'shell',
  })
  registerControlMethod('ext.exec', {
    callers: 'extensions',
    cap: 'process',
    handler: (params: unknown, ctx) => {
      const h = host()
      if (!h) return fail('no-extension-host')
      return h.runs.exec(ctx.identity, ctx.conn, params, ctx.token)
    },
  })
  registerControlMethod('ext.runAgent', {
    ...forExtension((h, id, conn, p) => h.runs.runAgent(id, conn, p)),
    cap: 'shell',
  })
  registerControlMethod(
    'ext.offerToAgent',
    forExtension((h, id, conn, p) => h.runs.offerToAgent(id, conn, p)),
  )
  registerControlMethod(
    'ext.focusPane',
    forExtension((h, id, conn, p) => h.runs.focusPane(id, conn, p)),
  )

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
      h.runs.reachHookCaller(p.extId, p.command, ctx.identity)
      return h.invoke(p.extId, p.command, p.args, h.paneCaller(ctx.identity))
    },
  })

  registerControlMethod(
    'ext.redact',
    forExtension((h, id, conn, p) => h.redactTexts(id, conn, p)),
  )

  registerControlMethod('ext.setAssistStatus', {
    ...forExtension((h, id, conn, p) => h.assistant.setAssistStatus(id, conn, p)),
    cap: 'assist',
  })
  registerControlMethod('ext.assistProviders', {
    ...forExtension((h, id, conn) => h.assistant.getAssistProviders(id, conn)),
    cap: 'assist',
  })
  registerControlMethod('ext.assistChunk', {
    ...forExtension((h, id, conn, p) => h.assistant.assistChunk(id, conn, p)),
    cap: 'assist',
  })
  registerControlMethod(
    'ext.locale',
    forExtension((h, id, conn) => h.getLocale(id, conn)),
  )
  registerControlMethod(
    'ext.shortcuts',
    forExtension((h, id, conn, p) => h.assistant.getShortcuts(id, conn, p)),
  )
  registerControlMethod(
    'ext.openAssistUi',
    forExtension((h, id, conn, p) => h.assistant.openAssistUi(id, conn, p)),
  )
  registerControlMethod(
    'ext.getSecret',
    forExtension((h, id, conn, p) => h.config.getSecret(id, conn, p)),
  )
  registerControlMethod(
    'ext.connections',
    forExtension((h, id, conn) => h.config.listConnections(id, conn)),
  )
  registerControlMethod(
    'ext.connection',
    forExtension((h, id, conn, p) => h.config.getConnection(id, conn, p)),
  )

  registerControlMethod(
    'ext.confirm',
    forExtension((h, id, conn, p) => h.runs.confirm(id, conn, p)),
  )
  registerControlMethod(
    'ext.openFolder',
    forExtension((h, id, conn, p) => h.windowRequests.openFolder(id, conn, p)),
  )
  registerControlMethod(
    'ext.sandboxDomains',
    forExtension((h, id, conn, p) => h.sandboxDomains(id, conn, p)),
  )
  registerControlMethod(
    'ext.closeFolder',
    forExtension((h, id, conn, p) => h.windowRequests.closeFolder(id, conn, p)),
  )
}
