import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { type FSWatcher, mkdirSync, readdirSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  AGENT_PLUGIN_CAPABILITY,
  agentSkillId,
  hookAgentsFor,
} from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
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
  AGENT_OFFER_LABEL_MAX,
  AGENT_OFFER_TEXT_MAX,
  AGENT_PROMPT_MAX,
  CONNECTIONS_CHANGED_EVENT,
  DIFF_TEXT_MAX,
  EXTENSION_EVENT_TYPES,
  EXTENSION_REDACT_TEXTS_MAX,
  EXTENSION_REDACT_TEXT_MAX,
  type ExtensionAgentOffer,
  type ExtensionCaller,
  type ExtensionCommandContribution,
  type ExtensionConnectionEntry,
  type ExtensionConnectionResult,
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
  type ExtensionSecretResult,
  type ExtensionSettingResult,
  type ExtensionSettingValues,
  type ExtensionStatus,
  OPEN_TERMINAL_WAIT_MAX_MS,
  SETTINGS_CHANGED_EVENT,
  TERMINAL_ARG_MAX,
  TERMINAL_COMMAND_MAX_ARGS,
  TERMINAL_TITLE_MAX,
  type TerminalWait,
  type WorkspaceChip,
  commandArgument,
  effectiveSettingValues,
  panelPath,
  validSettingValue,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { IconThemeContribution } from '@aurigax-ai/ostia-extension-sdk/contract/iconTheme'
import {
  LANGUAGE_SERVER_CAPABILITY,
  languageServerSummary,
} from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import {
  FOLDER_CLOSED_EVENT,
  type RemoteCwd,
  type RemoteFilesRequest,
  type RemoteFolder,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import type { Snippet } from '@aurigax-ai/ostia-extension-sdk/contract/snippets'
import type { AgentPluginSource } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
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
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc/node'
import type { RedactionResult } from '../../shared/privacy/redaction'
import { quoteArgv } from '../../shared/terminal/shellQuote'
import {
  type AgentOfferDelivery,
  type HeldResume,
  REACHED_PANES_MAX,
  agentName,
  agentPrompt,
  agentTaskLimiter,
  continueCommand,
  offerLabel,
  offerText,
  workspaceFolder,
  workspaceIdOf,
} from '../agents/extensionAgents'
import { dropIdentity, hasCap, setCaps } from '../approvals/capabilityStore'
import { registerControlMethod } from '../control/controlServer'
import {
  type PaneIdentity,
  registerExtension,
  removeExtension,
  resolveExternal,
} from '../control/idRegistry'
import {
  REMOTE_REQUEST_TIMEOUT_MS,
  RemoteFolders,
  type RemoteFoldersDeps,
} from '../files/remoteFolders'
import type { EditorLanguageSource } from '../lsp/editorLanguages'
import type { LanguageServerSource } from '../lsp/languageServers'
import { spawnFolder } from '../terminal/spawnCwd'
import { ExtensionAssist } from './extensionAssist'
import type { ExtensionConnections } from './extensionConnections'
import type { ExtensionExec } from './extensionExec'
import type { ExtensionLaunches } from './extensionLaunches'
import {
  type LoadedExtension,
  type Runtime,
  fail,
  isPlainRecord,
  withTimeout,
} from './extensionRuntime'
import { ExtensionSlots } from './extensionSlots'
import { type ExtensionStore, effectiveRecord, grantedCaps, needsApproval } from './extensionStore'
import type { KeymapSource } from './keymaps'
import type { LanguageSource } from './languagePacks'

export const MAX_RESTARTS = 3
const REQUEST_TIMEOUT_MS = 30_000
const INTERACTIVE_TIMEOUT_MS = 10 * 60_000
const DIFF_TITLE_MAX = 200
const DIFF_LANGUAGE_MAX = 40
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

const HOST_TERMINAL_NOTE = 'Runs outside the sandbox, in a terminal you can watch:'
export interface ExtensionSecretStore {
  keys: (extId: string) => string[]
  get: (extId: string, key: string) => string | null
  set: (
    extId: string,
    key: string,
    value: string | null,
  ) => { ok: true } | { ok: false; error: string }
}

export interface TerminalOpenRequest {
  command: string
  hostToken?: string
  workspaceId?: string
  windowId?: string
  afterPaneId?: string
  cwd?: string
  title?: string
  backgroundTab?: boolean
  pinTitle?: boolean
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

function terminalWaitMs(raw: unknown): number | null | string {
  if (raw === undefined) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return 'waitMs must be a positive number of milliseconds'
  }
  return Math.min(Math.round(raw), OPEN_TERMINAL_WAIT_MAX_MS)
}

function terminalArgv(raw: unknown): string[] | string {
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

function filePosition(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
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
  private terminalWaits = new Map<string, (wait: TerminalWait) => void>()
  private settings: Map<string, ExtensionSettingValues>
  private changes = new EventEmitter()
  private watchers: FSWatcher[] = []
  private readonly scheduleRescan = debounce(() => this.rescan(), RESCAN_DEBOUNCE_MS)
  private watching = false
  private announcedLocale: string
  private readonly agentTasks: ReturnType<typeof agentTaskLimiter>
  readonly remoteFolders: RemoteFolders | null
  readonly assistant: ExtensionAssist
  readonly slots: ExtensionSlots

  constructor(private readonly deps: ExtensionHostDeps) {
    this.changes.setMaxListeners(0)
    for (const ext of this.discover()) this.runtimes.set(ext.manifest.id, newRuntime(ext))
    this.settings = storedSettings(deps.readExtensionSettings?.())
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
      settingValues: (rt) => this.settingValues(rt),
    })
    this.announcedLocale = this.currentLocale()
    this.agentTasks = agentTaskLimiter(deps.agentTaskClock)
    this.remoteFolders = this.createRemoteFolders()
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
      settingValues: this.settingValues(rt),
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

  private settingValues(rt: Runtime): ExtensionSettingValues {
    return effectiveSettingValues(
      rt.ext.manifest.contributes.settings,
      this.settings.get(rt.ext.manifest.id),
    )
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

  snippets(): { extId: string; snippets: Snippet[] }[] {
    return [...this.runtimes.values()]
      .filter((rt) => this.active(rt) && rt.ext.manifest.contributes.snippets)
      .map((rt) => ({
        extId: rt.ext.manifest.id,
        snippets: rt.ext.manifest.contributes.snippets ?? [],
      }))
  }

  completionDirs(): string[] {
    return [...this.runtimes.values()]
      .filter((rt) => this.active(rt) && rt.ext.manifest.contributes.completions)
      .map((rt) => join(rt.ext.dir, rt.ext.manifest.contributes.completions ?? ''))
  }

  languages(): LanguageSource[] {
    return [...this.runtimes.values()]
      .filter((rt) => this.active(rt))
      .flatMap((rt) =>
        (rt.ext.manifest.contributes.languages ?? []).map((language) => ({
          extId: rt.ext.manifest.id,
          dir: rt.ext.dir,
          language,
        })),
      )
  }

  keymaps(): KeymapSource[] {
    return [...this.runtimes.values()]
      .filter((rt) => this.active(rt))
      .flatMap((rt) =>
        (rt.ext.manifest.contributes.keymaps ?? []).map((keymap) => ({
          extId: rt.ext.manifest.id,
          dir: rt.ext.dir,
          keymap,
        })),
      )
  }

  editorLanguages(): EditorLanguageSource[] {
    return [...this.runtimes.values()]
      .filter((rt) => this.active(rt))
      .flatMap((rt) =>
        (rt.ext.manifest.contributes.editorLanguages ?? []).map((language) => ({
          extId: rt.ext.manifest.id,
          dir: rt.ext.dir,
          language,
        })),
      )
  }

  private languageServerState(rt: Runtime, serverId: string): LanguageServerSource['state'] {
    if (this.pending(rt)) return 'pending'
    const record = this.record(rt)
    if (!record.enabled) return 'off'
    if (!this.granted(rt).includes(LANGUAGE_SERVER_CAPABILITY)) return 'pending'
    return record.serversOff?.includes(serverId) ? 'off' : 'on'
  }

  languageServers(): LanguageServerSource[] {
    return [...this.runtimes.values()].flatMap((rt) =>
      (rt.ext.manifest.contributes.languageServers ?? []).map((server) => ({
        extId: rt.ext.manifest.id,
        extName: rt.ext.manifest.name,
        dir: rt.ext.dir,
        builtin: rt.ext.builtin,
        state: this.languageServerState(rt, server.id),
        server,
        settingValues: this.settingValues(rt),
      })),
    )
  }

  setLanguageServerEnabled(extId: string, serverId: string, enabled: boolean): void {
    const rt = this.runtimes.get(extId)
    if (!rt || this.pending(rt)) return
    const declared = rt.ext.manifest.contributes.languageServers ?? []
    if (!declared.some((server) => server.id === serverId)) return
    const record = this.record(rt)
    const off = new Set(record.serversOff ?? [])
    if (enabled) off.delete(serverId)
    else off.add(serverId)
    const { serversOff: _previous, ...kept } = record
    this.deps.store.set(extId, {
      ...kept,
      enabled: enabled ? true : record.enabled,
      approved: record.approved ?? [],
      ...(off.size > 0 ? { serversOff: [...off] } : {}),
    })
    if (enabled && !record.enabled && this.eager(rt)) this.start(rt)
    this.changed(rt)
  }

  agentPlugins(): AgentPluginSource[] {
    return [...this.runtimes.values()]
      .filter((rt) => this.active(rt) && this.granted(rt).includes(AGENT_PLUGIN_CAPABILITY))
      .map((rt) => ({
        extId: rt.ext.manifest.id,
        dir: rt.ext.dir,
        skills: rt.ext.manifest.contributes.agentSkills ?? [],
        hooks: rt.ext.manifest.contributes.agentHooks ?? [],
      }))
      .filter((source) => source.skills.length > 0 || source.hooks.length > 0)
  }

  iconThemes(): { dir: string; theme: IconThemeContribution }[] {
    return [...this.runtimes.values()]
      .filter((rt) => this.active(rt))
      .flatMap((rt) =>
        (rt.ext.manifest.contributes.iconThemes ?? []).map((theme) => ({ dir: rt.ext.dir, theme })),
      )
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
    this.settleTerminalWait(type, payload)
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

  getSettings(identity: PaneIdentity, conn: MessageConnection) {
    const rt = this.runtimeOf(identity, conn)
    return { ok: true, values: this.settingValues(rt) }
  }

  setOwnSetting(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const p = (params ?? {}) as { key?: unknown; value?: unknown }
    if (typeof p.key !== 'string') return fail('invalid-params', 'key')
    const extId = rt.ext.manifest.id
    const res = this.setSetting(extId, p.key, p.value === undefined ? null : p.value)
    if (!res.ok) return fail(res.error)
    this.deps.broadcast('extensions:settings-stored', { extId, stored: res.stored })
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
    this.assistant.reloadAssistSettings()
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

  async openFile(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
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
    if (!this.deps.openFileIn) return fail('no-window')
    return this.deps.openFileIn(req)
  }

  async openTerminal(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const p = (params ?? {}) as Record<string, unknown>
    const argv = terminalArgv(p.command)
    if (typeof argv === 'string') return fail('invalid-params', argv)
    const rt = this.runtimeOf(identity, conn)
    const command = quoteArgv(argv)
    const req: TerminalOpenRequest = { command }
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
    if (p.host === true && this.deps.isSandboxed?.(req.workspaceId ?? '')) {
      const token = this.deps.hostGrants?.claim(rt.ext.manifest.id, command) ?? null
      if (!token)
        return fail(
          'host-not-approved',
          'a host terminal needs an approved ext.confirm with hostTerminal',
        )
      req.hostToken = token
      req.command = `${command}; exit`
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
    const waitMs = terminalWaitMs(p.waitMs)
    if (typeof waitMs === 'string') return fail('invalid-params', waitMs)
    if (!this.deps.openTerminalIn) return fail('no-window')
    const paneId = await this.deps.openTerminalIn(req)
    if (!paneId) return fail('not-opened', 'no workspace to open it in')
    this.reach(rt, paneId)
    this.markOpened(rt, paneId)
    if (waitMs === null) return { ok: true, paneId }
    return { ok: true, paneId, wait: await this.waitForTerminal(paneId, waitMs) }
  }

  private waitForTerminal(paneId: string, ms: number): Promise<TerminalWait> {
    this.terminalWaits.get(paneId)?.({ outcome: 'timeout' })
    return new Promise((resolve) => {
      const settle = (wait: TerminalWait): void => {
        clearTimeout(timer)
        if (this.terminalWaits.get(paneId) === settle) this.terminalWaits.delete(paneId)
        resolve(wait)
      }
      const timer = setTimeout(() => settle({ outcome: 'timeout' }), ms)
      timer.unref?.()
      this.terminalWaits.set(paneId, settle)
    })
  }

  private settleTerminalWait<T extends ExtensionEventType>(
    type: T,
    payload: ExtensionEventPayloads[T],
  ): void {
    if (type !== 'command.finished' && type !== 'pane.closed') return
    const { paneId, exitCode } = payload as { paneId: string; exitCode?: number }
    const settle = this.terminalWaits.get(paneId)
    if (!settle) return
    settle(type === 'pane.closed' ? { outcome: 'closed' } : { outcome: 'finished', exitCode })
  }

  private reach(rt: Runtime, paneId: string): void {
    if (rt.reached.size >= REACHED_PANES_MAX) {
      for (const id of rt.reached) if (resolveExternal(id)?.kind !== 'pane') rt.reached.delete(id)
    }
    if (rt.reached.size < REACHED_PANES_MAX) rt.reached.add(paneId)
  }

  private takeAgentTask(rt: Runtime): boolean {
    return this.agentTasks.take(rt.ext.manifest.id).allowed
  }

  agentNames(identity: PaneIdentity, conn: MessageConnection) {
    this.runtimeOf(identity, conn)
    return { ok: true, agents: this.deps.agentNames?.() ?? [] }
  }

  async runAgent(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const p = isPlainRecord(params) ? params : {}
    const workspaceId = workspaceIdOf(p.workspaceId)
    if (!workspaceId) return fail('invalid-params', 'workspaceId is required')
    if (p.background !== undefined && typeof p.background !== 'boolean') {
      return fail('invalid-params', 'background is true or false')
    }
    const prompt = agentPrompt(p.prompt)
    if (!prompt) {
      return fail(
        'invalid-params',
        `prompt must be 1-${AGENT_PROMPT_MAX} characters without control characters other than newlines and tabs`,
      )
    }
    const planned =
      p.continueFrom === undefined
        ? this.startCommand(p.agent, prompt, workspaceId)
        : await this.continuedCommand(rt, p.continueFrom, prompt, workspaceId)
    if ('error' in planned) return planned.error
    if (!this.deps.openTerminalIn) return fail('no-window')
    if (!this.takeAgentTask(rt)) return fail('rate-limited', 'too many agent tasks this minute')
    const paneId = await this.deps.openTerminalIn({
      command: planned.command,
      workspaceId,
      ...(planned.cwd ? { cwd: planned.cwd } : {}),
      ...(p.background === true ? { backgroundTab: true } : {}),
    })
    if (!paneId) return fail('not-opened', 'no workspace to open it in')
    this.reach(rt, paneId)
    this.markOpened(rt, paneId)
    return { ok: true, paneId }
  }

  private markOpened(rt: Runtime, paneId: string): void {
    if (rt.opened.size >= REACHED_PANES_MAX) {
      for (const id of rt.opened) if (resolveExternal(id)?.kind !== 'pane') rt.opened.delete(id)
    }
    if (rt.opened.size < REACHED_PANES_MAX) rt.opened.add(paneId)
  }

  openedBy(identity: PaneIdentity, paneId: string): boolean {
    const extId = identity.kind === 'extension' ? identity.extId : undefined
    const rt = extId ? this.runtimes.get(extId) : undefined
    return rt?.identity?.externalId === identity.externalId && rt.opened.has(paneId)
  }

  private startCommand(
    raw: unknown,
    prompt: string,
    workspaceId: string,
  ): { command: string; cwd?: string } | { error: unknown } {
    const agent = agentName(raw)
    if (!agent) {
      return { error: fail('invalid-params', 'agent must be one of the names ext.agents lists') }
    }
    const argv = this.deps.agentArgv?.(agent)
    if (!argv) return { error: fail('unknown-agent', 'no agent by that name') }
    const cwd = workspaceFolder(this.deps.workDirForWorkspace(workspaceId), homedir())
    return { command: quoteArgv([...argv, prompt]), ...(cwd ? { cwd } : {}) }
  }

  private async continuedCommand(
    rt: Runtime,
    raw: unknown,
    prompt: string,
    workspaceId: string,
  ): Promise<{ command: string; cwd: string } | { error: unknown }> {
    if (typeof raw !== 'string' || !rt.opened.has(raw)) {
      return {
        error: fail(
          'not-reached',
          'continueFrom is only for a pane you opened with ext.runAgent or ext.openTerminal',
        ),
      }
    }
    const pane = resolveExternal(raw)
    if (pane?.kind !== 'pane' || pane.workspaceId !== workspaceId) {
      return { error: fail('unknown-pane', 'that pane is closed or in another workspace') }
    }
    const found = await this.deps.resumeOf?.(pane)
    if (!found) return { error: fail('no-session', 'that pane has no agent session to continue') }
    const folder = spawnFolder(found.resume.cwd)
    if (folder.missing) {
      return { error: fail('resume-folder-missing', `${found.resume.cwd} no longer exists`) }
    }
    return { command: continueCommand(found, prompt), cwd: folder.cwd }
  }

  async offerToAgent(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const p = isPlainRecord(params) ? params : {}
    const workspaceId = workspaceIdOf(p.workspaceId)
    if (!workspaceId) return fail('invalid-params', 'workspaceId is required')
    const text = offerText(p.text)
    if (!text) {
      return fail(
        'invalid-params',
        `text must be one line of 1-${AGENT_OFFER_TEXT_MAX} characters without control characters`,
      )
    }
    const label = offerLabel(p.label)
    if (!label) {
      return fail(
        'invalid-params',
        `label must be one line of 1-${AGENT_OFFER_LABEL_MAX} characters without control characters`,
      )
    }
    if (!this.deps.offerToAgentIn) return fail('no-window')
    if (rt.offering) return fail('busy', 'an earlier offer is still waiting for the human')
    if (!this.takeAgentTask(rt)) return fail('rate-limited', 'too many agent tasks this minute')
    rt.offering = true
    try {
      const delivery = await this.deps.offerToAgentIn({
        extId: rt.ext.manifest.id,
        extName: this.shownName(rt),
        workspaceId,
        label,
        text,
      })
      if (!delivery.delivered) return fail('unknown-workspace', 'no window holds that workspace')
      if (!delivery.paneId) return { ok: true, sent: false }
      this.reach(rt, delivery.paneId)
      return { ok: true, sent: true, paneId: delivery.paneId }
    } finally {
      rt.offering = false
    }
  }

  focusPane(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const paneId = isPlainRecord(params) ? params.paneId : undefined
    if (typeof paneId !== 'string' || !rt.reached.has(paneId)) {
      return fail(
        'not-reached',
        'only a pane you opened, the human picked for you, or whose agent hook reached you',
      )
    }
    const pane = resolveExternal(paneId)
    if (pane?.kind !== 'pane') {
      rt.reached.delete(paneId)
      return fail('unknown-pane', 'that pane is closed')
    }
    if (!this.deps.focusPaneIn) return fail('no-window')
    return this.deps.focusPaneIn(pane) ? { ok: true } : fail('unknown-pane', 'that pane is closed')
  }

  reachHookCaller(extId: string, command: string, identity: PaneIdentity): void {
    if (identity.kind !== 'pane') return
    const rt = this.runtimes.get(extId)
    if (!rt || !this.active(rt) || !this.granted(rt).includes(AGENT_PLUGIN_CAPABILITY)) return
    const hooks = rt.ext.manifest.contributes.agentHooks ?? []
    if (hooks.some((hook) => hook.command === command)) this.reach(rt, identity.externalId)
  }

  exec(
    identity: PaneIdentity,
    conn: MessageConnection,
    params: unknown,
    token?: CancellationToken,
  ) {
    const rt = this.runtimeOf(identity, conn)
    if (!this.deps.exec) return fail('no-window')
    const abort = new AbortController()
    token?.onCancellationRequested(() => abort.abort())
    if (token?.isCancellationRequested) abort.abort()
    return this.deps.exec.run(rt.ext.manifest.id, params, abort.signal)
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

  async openFolder(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    if (!this.remoteFolders) return fail('no-window')
    return this.remoteFolders.open({ id: rt.ext.manifest.id, name: this.shownName(rt) }, params)
  }

  closeFolder(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const folderId = (params as { folderId?: unknown } | null)?.folderId
    const closed = this.remoteFolders?.closeByExtension(rt.ext.manifest.id, folderId) ?? false
    return closed ? { ok: true } : fail('unknown-folder')
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
      extName: this.shownName(rt),
      title,
      message,
    }
    const detail = text(p.detail, CONFIRM_DETAIL_MAX)
    if (detail) req.detail = detail
    const confirmLabel = text(p.confirmLabel, CONFIRM_LABEL_MAX)
    if (confirmLabel) req.confirmLabel = confirmLabel
    const cancelLabel = text(p.cancelLabel, CONFIRM_LABEL_MAX)
    if (cancelLabel) req.cancelLabel = cancelLabel
    let hostCommand: string | null = null
    if (p.hostTerminal !== undefined) {
      const argv = terminalArgv(p.hostTerminal)
      if (typeof argv === 'string') return fail('invalid-params', argv)
      hostCommand = quoteArgv(argv)
      req.detail = `${req.detail ? `${req.detail}\n\n` : ''}${HOST_TERMINAL_NOTE}\n${hostCommand}`
    }
    const confirmed = await this.deps.confirm(req)
    if (confirmed && hostCommand) this.deps.hostGrants?.offer(rt.ext.manifest.id, hostCommand)
    return { ok: true, confirmed }
  }

  getSecret(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const key = (params as { key?: unknown } | null)?.key
    const declared = rt.ext.manifest.contributes.secrets.some((s) => s.key === key)
    if (typeof key !== 'string' || !declared) {
      return fail('not-contributed', `no secret '${String(key)}' in manifest`)
    }
    return { ok: true, value: this.deps.secrets?.get(rt.ext.manifest.id, key) ?? null }
  }

  setSecret(extId: string, key: string, value: unknown): ExtensionSecretResult {
    const rt = this.runtimes.get(extId)
    if (!rt) return { ok: false, error: 'unknown-extension' }
    if (!rt.ext.manifest.contributes.secrets.some((s) => s.key === key)) {
      return { ok: false, error: 'unknown-secret' }
    }
    if (value !== null && typeof value !== 'string') return { ok: false, error: 'invalid-value' }
    if (!this.deps.secrets) return { ok: false, error: 'encryption-unavailable' }
    const res = this.deps.secrets.set(extId, key, value)
    if (!res.ok) return res
    if (rt.conn) {
      const payload = { values: this.settingValues(rt) }
      void rt.conn
        .sendNotification('ext.event', { type: SETTINGS_CHANGED_EVENT, payload })
        .catch(() => {})
    }
    this.changed(rt)
    return { ok: true, list: this.list() }
  }

  connectionsOf(extId: string): ExtensionConnectionEntry[] {
    const rt = this.runtimes.get(extId)
    if (!rt || !this.deps.connections) return []
    return this.deps.connections.list(extId, rt.ext.manifest.contributes.connections ?? [])
  }

  saveConnection(extId: string, req: unknown): ExtensionConnectionResult {
    const rt = this.runtimes.get(extId)
    if (!rt) return { ok: false, error: 'unknown-extension' }
    const kinds = rt.ext.manifest.contributes.connections ?? []
    if (kinds.length === 0) return { ok: false, error: 'not-contributed' }
    if (!this.deps.connections) return { ok: false, error: 'unavailable' }
    const res = this.deps.connections.save(extId, kinds, req)
    if (res.ok) this.connectionsChanged(rt)
    return res
  }

  removeConnection(extId: string, name: unknown): ExtensionConnectionResult {
    const rt = this.runtimes.get(extId)
    if (!rt) return { ok: false, error: 'unknown-extension' }
    if (!this.deps.connections) return { ok: false, error: 'unavailable' }
    const res = this.deps.connections.remove(extId, name)
    if (res.ok) this.connectionsChanged(rt)
    return res
  }

  private connectionsChanged(rt: Runtime): void {
    if (rt.conn) {
      void rt.conn
        .sendNotification('ext.event', { type: CONNECTIONS_CHANGED_EVENT, payload: {} })
        .catch(() => {})
    }
    this.changed(rt)
  }

  listConnections(identity: PaneIdentity, conn: MessageConnection) {
    const rt = this.runtimeOf(identity, conn)
    const kinds = rt.ext.manifest.contributes.connections ?? []
    return { ok: true, connections: this.deps.connections?.names(rt.ext.manifest.id, kinds) ?? [] }
  }

  getConnection(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const kinds = rt.ext.manifest.contributes.connections ?? []
    const name = (params as { name?: unknown } | null)?.name
    if (typeof name !== 'string') return fail('invalid-params', 'name must be a string')
    return {
      ok: true,
      connection: this.deps.connections?.value(rt.ext.manifest.id, kinds, name) ?? null,
    }
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
    ...forExtension((h, id, conn, p) => h.notify(id, conn, p)),
    cap: 'notify',
  })
  registerControlMethod(
    'ext.openPanel',
    forExtension((h, id, conn, p) => h.openPanel(id, conn, p)),
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
    forExtension((h, id, conn) => h.getSettings(id, conn)),
  )
  registerControlMethod(
    'ext.setSetting',
    forExtension((h, id, conn, p) => h.setOwnSetting(id, conn, p)),
  )

  registerControlMethod(
    'ext.openDiff',
    forExtension((h, id, conn, p) => h.openDiff(id, conn, p)),
  )

  registerControlMethod(
    'ext.openFile',
    forExtension((h, id, conn, p) => h.openFile(id, conn, p)),
  )

  registerControlMethod('ext.openTerminal', {
    ...forExtension((h, id, conn, p) => h.openTerminal(id, conn, p)),
    cap: 'shell',
  })

  registerControlMethod('ext.agents', {
    ...forExtension((h, id, conn) => h.agentNames(id, conn)),
    cap: 'shell',
  })
  registerControlMethod('ext.exec', {
    callers: 'extensions',
    cap: 'process',
    handler: (params: unknown, ctx) => {
      const h = host()
      if (!h) return fail('no-extension-host')
      return h.exec(ctx.identity, ctx.conn, params, ctx.token)
    },
  })
  registerControlMethod('ext.runAgent', {
    ...forExtension((h, id, conn, p) => h.runAgent(id, conn, p)),
    cap: 'shell',
  })
  registerControlMethod(
    'ext.offerToAgent',
    forExtension((h, id, conn, p) => h.offerToAgent(id, conn, p)),
  )
  registerControlMethod(
    'ext.focusPane',
    forExtension((h, id, conn, p) => h.focusPane(id, conn, p)),
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
      h.reachHookCaller(p.extId, p.command, ctx.identity)
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
    forExtension((h, id, conn, p) => h.getSecret(id, conn, p)),
  )
  registerControlMethod(
    'ext.connections',
    forExtension((h, id, conn) => h.listConnections(id, conn)),
  )
  registerControlMethod(
    'ext.connection',
    forExtension((h, id, conn, p) => h.getConnection(id, conn, p)),
  )

  registerControlMethod(
    'ext.confirm',
    forExtension((h, id, conn, p) => h.confirm(id, conn, p)),
  )
  registerControlMethod(
    'ext.openFolder',
    forExtension((h, id, conn, p) => h.openFolder(id, conn, p)),
  )
  registerControlMethod(
    'ext.sandboxDomains',
    forExtension((h, id, conn, p) => h.sandboxDomains(id, conn, p)),
  )
  registerControlMethod(
    'ext.closeFolder',
    forExtension((h, id, conn, p) => h.closeFolder(id, conn, p)),
  )
}
