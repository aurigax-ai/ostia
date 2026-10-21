import { EventEmitter } from 'node:events'
import {
  AGENT_EXTENSION_ID,
  type AgentReply,
  type AgentRequest,
} from '@aurigax-ai/ostia-extension-sdk/contract/agent'
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
  commandArgument,
  EXTENSION_REDACT_TEXT_MAX,
  EXTENSION_REDACT_TEXTS_MAX,
  type ExtensionCaller,
  type ExtensionCommandContribution,
  type ExtensionInfo,
  type ExtensionManifest,
  type ExtensionResult,
  type ExtensionStatus,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import {
  type BrowseCandidate,
  browseKindFor,
  FILE_CONTENTS_CAPABILITY,
  type KindRoles,
} from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { languageServerSummary } from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import {
  FOLDER_CLOSED_EVENT,
  type RemoteFilesRequest,
  type RemoteFolder,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { agentSkillProblems } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { discoverExtensions } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import {
  loadLocaleCatalogs,
  manifestIn,
} from '@aurigax-ai/ostia-extension-sdk/manifest/localeCatalogs'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { ExtensionCommandRef } from '../../shared/control/commands'
import { hasCap } from '../approvals/capabilityStore'
import type { PaneIdentity } from '../control/idRegistry'
import { REMOTE_REQUEST_TIMEOUT_MS, RemoteFolders } from '../files/remoteFolders'
import { ExtensionAssist } from './extensionAssist'
import { ExtensionBrowse } from './extensionBrowse'
import { ExtensionConfig } from './extensionConfig'
import { ExtensionContributions } from './extensionContributions'
import { ExtensionEvents } from './extensionEvents'
import type { ExtensionHostDeps } from './extensionHostDeps'
import { ExtensionPanels } from './extensionPanels'
import { ExtensionPhoneScreens } from './extensionPhoneScreens'
import { ExtensionProcesses } from './extensionProcesses'
import { ExtensionRuns } from './extensionRuns'
import {
  fail,
  type LoadedExtension,
  newRuntime,
  normalizeResult,
  REQUEST_TIMEOUT_MS,
  type Runtime,
  type ServingCalls,
  withTimeout,
} from './extensionRuntime'
import { ExtensionSlots } from './extensionSlots'
import { effectiveRecord, grantedCaps, kindApproved, needsApproval } from './extensionStore'
import { ExtensionWindowRequests } from './extensionWindowRequests'

const INTERACTIVE_TIMEOUT_MS = 10 * 60_000
const AGENT_REQUEST_TIMEOUT_MS = 60_000

function shadowedOf(
  shadowed: { name: string; patterns: string[] }[],
): { shadowed: { name: string; patterns: string[] }[] } | Record<string, never> {
  return shadowed.length > 0 ? { shadowed } : {}
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
  readonly browse: ExtensionBrowse
  readonly phoneScreens: ExtensionPhoneScreens
  private browseSignature = ''

  constructor(private readonly deps: ExtensionHostDeps) {
    this.changes.setMaxListeners(0)
    for (const ext of this.discover()) this.runtimes.set(ext.manifest.id, newRuntime(ext))
    this.phoneScreens = new ExtensionPhoneScreens({
      links: deps.screenLinks,
      runtimeOf: (identity, conn) => this.runtimeOf(identity, conn),
      active: (rt) => this.active(rt),
    })
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
      kindApproved: (rt, kind) => this.kindApproved(rt, kind),
      userCaller: (workspaceId, extra) => this.userCaller(workspaceId, extra),
    })
    this.browse = new ExtensionBrowse({
      candidates: () => this.browseCandidates(),
      connected: (extId) => {
        const rt = this.runtimes.get(extId)
        if (!rt) return Promise.reject(new Error('unknown extension'))
        return this.processes.connected(rt)
      },
      process: (extId) => this.runtimes.get(extId)?.proc ?? null,
      recycle: (extId) => {
        const rt = this.runtimes.get(extId)
        if (rt) this.processes.recycle(rt)
      },
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
    this.browseSignature = this.browse.kindsSignature()
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
    const browses = (rt.ext.manifest.contributes.fileKinds ?? []).some((kind) => kind.browse)
    return effectiveRecord(
      rt.ext.builtin,
      this.deps.store.get(rt.ext.manifest.id),
      browses ? [FILE_CONTENTS_CAPABILITY] : [],
    )
  }

  private browseCandidates(): BrowseCandidate[] {
    const found: BrowseCandidate[] = []
    for (const rt of this.runtimes.values()) {
      if (!this.active(rt) || !this.granted(rt).includes(FILE_CONTENTS_CAPABILITY)) continue
      for (const kind of rt.ext.manifest.contributes.fileKinds ?? []) {
        if (!kind.browse || !this.kindApproved(rt, kind)) continue
        found.push({
          extId: rt.ext.manifest.id,
          builtin: rt.ext.builtin,
          kind: { id: kind.id, selector: kind.selector },
        })
      }
    }
    return found
  }

  private shadowedPatterns(rt: Runtime, kind: KindRoles): { name: string; patterns: string[] }[] {
    if (!kind.browse) return []
    const candidates = this.browseCandidates()
    const extId = rt.ext.manifest.id
    if (!candidates.some((c) => c.extId === extId && c.kind.id === kind.id)) return []
    const lost = new Map<string, string[]>()
    for (const { filenamePattern } of kind.selector) {
      const sample = filenamePattern.startsWith('*.')
        ? `x${filenamePattern.slice(1)}`
        : filenamePattern
      const winner = browseKindFor(sample, candidates)
      if (!winner || winner.extId === extId) continue
      lost.set(winner.extId, [...(lost.get(winner.extId) ?? []), filenamePattern])
    }
    return [...lost].map(([winner, patterns]) => ({ name: this.displayName(winner), patterns }))
  }

  private kindApproved(rt: Runtime, kind: KindRoles): boolean {
    return kindApproved(rt.ext.builtin, this.deps.store.get(rt.ext.manifest.id), kind)
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
        ? {
            title: m.contributes.panel.title,
            icon: m.contributes.panel.icon,
            toolbar: m.contributes.panel.toolbar,
          }
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
      fileKinds: (m.contributes.fileKinds ?? []).map((kind) => ({
        id: kind.id,
        displayName: kind.displayName,
        selector: kind.selector,
        ...(kind.view ? { view: { priority: kind.view.priority } } : {}),
        ...(kind.browse ? { browse: true as const } : {}),
        ...shadowedOf(this.shadowedPatterns(rt, kind)),
        approved: this.kindApproved(rt, kind),
      })),
      agentSkills: (m.contributes.agentSkills ?? []).map((skill) => agentSkillId(m.id, skill.name)),
      agentSkillProblems: agentSkillProblems(rt.ext.dir, rt.ext.manifest),
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
    this.phoneScreens.recheck()
    this.deps.broadcast('extensions:changed', this.list())
    this.assistant.assistChanged()
    this.deps.onChanged?.()
    const signature = this.browse.kindsSignature()
    if (signature !== this.browseSignature) {
      this.browseSignature = signature
      this.deps.onBrowseKindsChanged?.()
    }
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
    const serving = caller.paneId
    const side = caller.kind === 'pane' ? 'cli' : 'user'
    if (serving) {
      const calls = rt.serving.get(serving) ?? { cli: 0, user: 0 }
      calls[side]++
      rt.serving.set(serving, calls)
    }
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
    } finally {
      if (serving) this.releaseServing(rt, serving, side)
    }
  }

  async agentContext(
    workspaceId: string,
    cwd: string,
    sessionId: string,
  ): Promise<{ text: string; count: number }> {
    const texts: string[] = []
    let count = 0
    for (const [extId, rt] of this.runtimes) {
      if (!rt.ext.builtin || extId === AGENT_EXTENSION_ID) continue
      const hooks = rt.ext.manifest.contributes.agentHooks ?? []
      const hook = hooks.find((h) => h.event === 'SessionStart')
      if (!hook || !this.runs.declaresHook(extId, hook.command, 'SessionStart')) continue
      const res = await this.invoke(
        extId,
        hook.command,
        { argv: ['agent', 'SessionStart'], stdin: JSON.stringify({ session_id: sessionId, cwd }) },
        this.userCaller(workspaceId, { cwd }),
      )
      if (!res.ok || !res.text) continue
      texts.push(res.text)
      const counted = isRecord(res.data) ? res.data.count : undefined
      count += typeof counted === 'number' ? counted : 0
    }
    return { text: texts.join('\n\n'), count }
  }

  private releaseServing(rt: Runtime, paneId: string, side: keyof ServingCalls): void {
    const calls = rt.serving.get(paneId)
    if (!calls) return
    calls[side]--
    if (calls.cli + calls.user <= 0) rt.serving.delete(paneId)
  }

  async agentRequest(request: AgentRequest): Promise<AgentReply> {
    const rt = this.runtimes.get(AGENT_EXTENSION_ID)
    if (!rt || !this.active(rt)) return { ok: false, error: 'unavailable' }
    try {
      const conn = await this.processes.connected(rt)
      const raw = await withTimeout(
        conn.sendRequest('ext.agent', request),
        AGENT_REQUEST_TIMEOUT_MS,
        `${AGENT_EXTENSION_ID} ${request.op}`,
      )
      return isRecord(raw) && typeof raw.ok === 'boolean'
        ? (raw as AgentReply)
        : { ok: false, error: 'failed' }
    } catch (err) {
      return { ok: false, error: 'unavailable', message: (err as Error).message }
    }
  }

  userCaller(workspaceId: string | null, extra: Partial<ExtensionCaller> = {}): ExtensionCaller {
    const caller: ExtensionCaller = { kind: 'user', capabilities: [...ALL_CAPABILITIES], ...extra }
    if (workspaceId) {
      caller.workspaceId = workspaceId
      const workDir = this.deps.workDirForWorkspace(workspaceId)
      if (workDir) caller.workDir = workDir
      if (this.deps.isSandboxed(workspaceId)) caller.sandboxed = true
    }
    return caller
  }

  paneCaller(identity: PaneIdentity, hook?: { extId: string; command: string }): ExtensionCaller {
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
    if (this.deps.isSandboxed(identity.workspaceId)) caller.sandboxed = true
    if (identity.manager) caller.manager = true
    if (this.deps.agentRunning?.(identity.paneId)) caller.agentRunning = true
    if (hook && this.runs.declaresHook(hook.extId, hook.command, 'UserPromptSubmit')) {
      const typed = this.deps.claimHumanPrompt?.(identity.paneId, hook.extId)
      if (typed) caller.humanPrompt = typed
    }
    const remote = this.deps.remoteCwdForPane?.(identity.paneId)
    if (remote) caller.remote = remote
    return caller
  }

  paletteCommand(id: string): ExtensionCommandRef | null {
    const dot = id.indexOf('.')
    if (dot <= 0) return null
    const extId = id.slice(0, dot)
    const command = id.slice(dot + 1)
    const rt = this.runtimes.get(extId)
    if (!rt || !this.active(rt)) return null
    return this.commandsOf(rt).some((c) => c.id === command && c.palette)
      ? { extId, command }
      : null
  }

  commandCapabilities(extId: string, command: string): Capability[] {
    const rt = this.runtimes.get(extId)
    return rt ? (this.commandsOf(rt).find((c) => c.id === command)?.capabilities ?? []) : []
  }

  sandboxDomains(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const workspaceId = isRecord(params) ? params.workspaceId : undefined
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return fail('invalid-params', 'workspaceId is required')
    }
    if (!rt.callerWorkspaces.has(workspaceId)) {
      return fail('not-reached', 'only a workspace this extension has a caller in')
    }
    const domains = this.deps.sandboxDomains(workspaceId)
    if (!domains) return fail('not-sandboxed', 'the workspace is not sandboxed')
    return { ok: true, domains: [...domains] }
  }

  builtinId(identity: PaneIdentity, conn: MessageConnection): string | null {
    try {
      const rt = this.runtimeOf(identity, conn)
      return rt.ext.builtin ? rt.ext.manifest.id : null
    } catch {
      return null
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

  openedBy(identity: PaneIdentity, paneId: string): boolean {
    const extId = identity.kind === 'extension' ? identity.extId : undefined
    const rt = extId ? this.runtimes.get(extId) : undefined
    return rt?.identity?.externalId === identity.externalId && rt.opened.has(paneId)
  }

  async redactTexts(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    this.runtimeOf(identity, conn)
    const texts = isRecord(params) ? params.texts : undefined
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
        agentHooks: e.agentHooks,
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
