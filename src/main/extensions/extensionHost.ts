import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { agentSkillId, hookAgentsFor } from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import type { AssistOpenUiRequest } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import {
  ALL_CAPABILITIES,
  type Capability,
} from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import {
  EXTENSION_BASE_LOCALE,
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
import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { RedactionResult } from '../../shared/privacy/redaction'
import type { AgentOfferDelivery, HeldResume } from '../agents/extensionAgents'
import { hasCap } from '../approvals/capabilityStore'
import type { PaneIdentity } from '../control/idRegistry'
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
import { ExtensionProcesses } from './extensionProcesses'
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
  newRuntime,
  withTimeout,
} from './extensionRuntime'
import { ExtensionSlots } from './extensionSlots'
import { type ExtensionStore, effectiveRecord, grantedCaps, needsApproval } from './extensionStore'
import { ExtensionWindowRequests } from './extensionWindowRequests'
const REQUEST_TIMEOUT_MS = 30_000
const INTERACTIVE_TIMEOUT_MS = 10 * 60_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])

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
  private announcedLocale: string
  readonly remoteFolders: RemoteFolders | null
  readonly assistant: ExtensionAssist
  readonly slots: ExtensionSlots
  readonly runs: ExtensionRuns
  readonly contributions: ExtensionContributions
  readonly config: ExtensionConfig
  readonly windowRequests: ExtensionWindowRequests
  readonly processes: ExtensionProcesses

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
      eager: (rt) => this.processes.eager(rt),
      start: (rt) => this.processes.start(rt),
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
      onDemand: (rt) => this.processes.onDemand(rt),
      eager: (rt) => this.processes.eager(rt),
      start: (rt) => this.processes.start(rt),
      settingValues: (rt) => this.config.settingValues(rt),
    })
    this.announcedLocale = this.currentLocale()
    this.remoteFolders = this.createRemoteFolders()
    this.processes = new ExtensionProcesses({
      deps,
      runtimes: this.runtimes,
      changes: this.changes,
      remoteFolders: this.remoteFolders,
      assistant: this.assistant,
      slots: this.slots,
      list: () => this.list(),
      record: (rt) => this.record(rt),
      active: (rt) => this.active(rt),
      changed: (rt) => this.changed(rt),
      granted: (rt) => this.granted(rt),
      discover: () => this.discover(),
      log: (extId, line) => this.log(extId, line),
    })
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
      const conn = await this.processes.connected(rt, command)
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
      if (rt.ext.manifest.main) this.processes.start(rt)
      const src = this.filePanelUrl(rt, panel.entry, path)
      return src ? { ok: true, src } : { ok: false, error: 'panel-url-not-allowed' }
    }
    try {
      const conn = await this.processes.connected(rt)
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
}
