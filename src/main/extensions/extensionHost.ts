import { EventEmitter } from 'node:events'
import { agentSkillId, hookAgentsFor } from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
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
  EXTENSION_REDACT_TEXTS_MAX,
  EXTENSION_REDACT_TEXT_MAX,
  type ExtensionCaller,
  type ExtensionCommandContribution,
  type ExtensionInfo,
  type ExtensionManifest,
  type ExtensionResult,
  type ExtensionStatus,
  commandArgument,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { languageServerSummary } from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import {
  FOLDER_CLOSED_EVENT,
  type RemoteFilesRequest,
  type RemoteFolder,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { discoverExtensions } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import {
  loadLocaleCatalogs,
  manifestIn,
} from '@aurigax-ai/ostia-extension-sdk/manifest/localeCatalogs'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { hasCap } from '../approvals/capabilityStore'
import type { PaneIdentity } from '../control/idRegistry'
import { REMOTE_REQUEST_TIMEOUT_MS, RemoteFolders } from '../files/remoteFolders'
import { ExtensionAssist } from './extensionAssist'
import { ExtensionConfig } from './extensionConfig'
import { ExtensionContributions } from './extensionContributions'
import { ExtensionEvents } from './extensionEvents'
import type { ExtensionHostDeps } from './extensionHostDeps'
import { ExtensionPanels } from './extensionPanels'
import { ExtensionProcesses } from './extensionProcesses'
import { ExtensionRuns } from './extensionRuns'
import {
  type LoadedExtension,
  REQUEST_TIMEOUT_MS,
  type Runtime,
  fail,
  isPlainRecord,
  newRuntime,
  withTimeout,
} from './extensionRuntime'
import { ExtensionSlots } from './extensionSlots'
import { effectiveRecord, grantedCaps, needsApproval } from './extensionStore'
import { ExtensionWindowRequests } from './extensionWindowRequests'
const INTERACTIVE_TIMEOUT_MS = 10 * 60_000

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
  readonly panels: ExtensionPanels
  readonly events: ExtensionEvents

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
    this.panels = new ExtensionPanels({
      deps,
      runtimes: this.runtimes,
      processes: this.processes,
      active: (rt) => this.active(rt),
      userCaller: (workspaceId, extra) => this.userCaller(workspaceId, extra),
    })
    this.events = new ExtensionEvents({
      deps,
      runtimes: this.runtimes,
      runs: this.runs,
      runtimeOf: (identity, conn) => this.runtimeOf(identity, conn),
      changed: (rt) => this.changed(rt),
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
      fileViewers: (m.contributes.fileViewers ?? []).map(({ entry: _entry, ...viewer }) => viewer),
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
