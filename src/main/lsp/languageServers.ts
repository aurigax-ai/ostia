import { languageForPath } from '@aurigax-ai/ostia-extension-sdk/contract/editorLanguages'
import {
  documentLanguageId,
  substituteJson,
} from '@aurigax-ai/ostia-extension-sdk/contract/languageServerConfig'
import {
  type JsonObject,
  type LanguageServerInfo,
  type LanguageServerOverrideProblem,
  LSP_LOG_MAX_ENTRIES,
  type LspLog,
  type LspLogEntry,
  type LspSessionInfo,
  type LspStopReason,
  languageServerFeature,
  languageServerKey,
  pinnedVersion,
} from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import type { LogFields } from '../diagnostics/appLog'
import type { TreeChange } from '../files/fileWatch'
import { isInsidePath } from '../platform/pathGuard'
import type { Requirement } from '../platform/systemRequirements'
import {
  type LanguageServerSource,
  type ManagedServerFiles,
  ServerBinaries,
  type ServerRecord,
} from './serverBinaries'
import {
  findServerRoot,
  type LanguageServerSandbox,
  type SpawnServer,
  sourceSignature,
  startServer,
} from './serverSpawn'
import { type Session, SessionProtocol } from './sessionProtocol'

const LSP_IDLE_STOP_MS = 60_000
const LSP_MAX_RESTARTS = 5
const LSP_RESTART_DELAY_MS = 500
const LSP_STABLE_RUN_MS = 60_000
const LSP_STOP_GRACE_MS = 2_000
const HOST_SCOPE = 'host'
const PROGRAM_PLATFORMS: NodeJS.Platform[] = ['linux', 'darwin', 'win32']

export interface LanguageServerPane {
  windowId: string
  workspaceId: string
}

export interface LanguageServersDeps {
  sources: () => LanguageServerSource[]
  nodePath: string
  env: () => NodeJS.ProcessEnv
  pane: (paneId: string) => LanguageServerPane | undefined
  confine: (path: string) => string | null
  workDir: (workspaceId: string) => string | undefined
  roots: () => string[]
  sandbox: LanguageServerSandbox
  findProgram: (program: string) => string | null
  languageOf?: (path: string) => string
  managed: ManagedServerFiles
  registerRequirements: (feature: string, requirements: Requirement[], label?: string) => void
  overrideProblem?: (path: string) => LanguageServerOverrideProblem | null
  realPath?: (path: string) => string
  watchTree?: (root: string, onChange: (changes: TreeChange[]) => void) => (() => void) | null
  post: (windowId: string, channel: string, ...args: unknown[]) => void
  changed: (list: LanguageServerInfo[]) => void
  log?: (event: string, fields: LogFields) => void
  spawn?: SpawnServer
  idleMs?: number
  restartDelayMs?: number
  stopGraceMs?: number
  now?: () => number
}

interface Slot {
  restarts: number
  restartAt: number
  crashed: boolean
}

export class LanguageServers {
  private readonly sessions = new Map<string, Session>()
  private readonly starting = new Map<string, Promise<Session | null>>()
  private readonly slots = new Map<string, Slot>()
  private readonly records = new Map<string, ServerRecord>()
  private readonly refusals = new Map<string, string>()
  private readonly epochs = new Map<string, number>()
  private registered = new Set<string>()
  private stopped = false

  private readonly protocol: SessionProtocol
  private readonly binaries: ServerBinaries

  constructor(private readonly deps: LanguageServersDeps) {
    this.protocol = new SessionProtocol({
      sessions: this.sessions,
      record: (key) => this.record(key),
      note: (key, entry) => this.note(key, entry),
      now: () => this.now(),
      post: deps.post,
      watchTree: deps.watchTree,
      log: deps.log,
      onExit: (session, code, signal) => this.onExit(session, code, signal),
    })
    this.binaries = new ServerBinaries({
      sources: deps.sources,
      findProgram: deps.findProgram,
      managed: deps.managed,
      overrideProblem: deps.overrideProblem,
      log: deps.log,
      slots: this.slots,
      live: (key) => this.live(key),
      stop: (session, reason) => this.stop(session, reason),
      enabledSource: (key) => this.enabledSource(key),
      record: (key) => this.record(key),
      note: (key, entry) => this.note(key, entry),
      now: () => this.now(),
      changed: () => this.changed(),
    })
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private record(key: string): ServerRecord {
    let record = this.records.get(key)
    if (!record) {
      record = {
        entries: [],
        errors: new Map(),
        sandboxProblem: null,
        fetching: null,
        fetchFailure: null,
        fetchHeld: false,
      }
      this.records.set(key, record)
    }
    return record
  }

  private note(key: string, entry: LspLogEntry): void {
    const { entries } = this.record(key)
    entries.push(entry)
    if (entries.length > LSP_LOG_MAX_ENTRIES)
      entries.splice(0, entries.length - LSP_LOG_MAX_ENTRIES)
  }

  private slot(slotKey: string): Slot {
    let slot = this.slots.get(slotKey)
    if (!slot) {
      slot = { restarts: 0, restartAt: 0, crashed: false }
      this.slots.set(slotKey, slot)
    }
    return slot
  }

  private live(key: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.key === key && s.stopping === null)
  }

  private changed(): void {
    this.deps.changed(this.servers())
  }

  servers(): LanguageServerInfo[] {
    return this.binaries.servers()
  }

  log(key: unknown): LspLog {
    const record = typeof key === 'string' ? this.records.get(key) : undefined
    return {
      entries: record ? [...record.entries] : [],
      errors: record ? Object.fromEntries(record.errors) : {},
    }
  }

  refresh(): void {
    const sources = this.deps.sources()
    const on = new Map<string, LanguageServerSource>()
    const programs = new Set<string>()
    const pinned = new Map<string, string>()
    for (const source of sources) {
      const key = languageServerKey(source.extId, source.server.id)
      if (source.state === 'on') on.set(key, source)
      const { run } = source.server
      const version = pinnedVersion(run)
      if (version !== null) pinned.set(key, version)
      const needed = source.override ? null : this.binaries.requiredProgram(run)
      if (needed === null) continue
      const feature = languageServerFeature(key)
      programs.add(feature)
      this.deps.registerRequirements(
        feature,
        [{ ...needed, platforms: PROGRAM_PLATFORMS }],
        source.server.name,
      )
    }
    for (const feature of this.registered) {
      if (!programs.has(feature)) this.deps.registerRequirements(feature, [])
    }
    this.registered = programs
    this.deps.managed.retain(pinned)
    for (const session of [...this.sessions.values()]) {
      if (session.stopping !== null) continue
      const source = on.get(session.key)
      if (!source) void this.stop(session, 'off')
      else if (sourceSignature(source) !== session.signature) void this.stop(session, 'restart')
      else this.protocol.pushSettings(session, source)
    }
    for (const key of this.records.keys()) {
      if (on.has(key)) continue
      this.forgetSlots(key)
      this.record(key).sandboxProblem = null
    }
    this.changed()
  }

  private enabledSource(key: unknown): LanguageServerSource | undefined {
    return this.deps
      .sources()
      .find((s) => s.state === 'on' && languageServerKey(s.extId, s.server.id) === key)
  }

  fetch(key: unknown): Promise<void> {
    return this.binaries.fetch(key)
  }

  removeDownload(key: unknown): Promise<void> {
    return this.binaries.removeDownload(key)
  }

  private forgetSlots(key: string): void {
    const prefix = `${key}\n`
    for (const slotKey of [...this.slots.keys()]) {
      if (slotKey.startsWith(prefix)) this.slots.delete(slotKey)
    }
    for (const slotKey of [...this.refusals.keys()]) {
      if (slotKey.startsWith(prefix)) this.refusals.delete(slotKey)
    }
  }

  async open(windowId: string, paneId: unknown, filePath: unknown): Promise<LspSessionInfo[]> {
    if (this.stopped || typeof paneId !== 'string' || typeof filePath !== 'string') return []
    const pane = this.deps.pane(paneId)
    if (!pane || pane.windowId !== windowId) return []
    const file = this.deps.confine(filePath)
    if (file === null) return []
    const language = (this.deps.languageOf ?? languageForPath)(file)
    const epoch = this.epochs.get(windowId) ?? 0
    const sandboxed = this.deps.sandbox.owner(pane.workspaceId) !== null
    const workDir = this.deps.workDir(pane.workspaceId)
    const matching = this.deps
      .sources()
      .filter((source) => source.state === 'on' && source.server.languages.includes(language))
    const opened = await Promise.all(
      matching.map(async (source): Promise<LspSessionInfo | null> => {
        const session = await this.acquire(source, pane, file)
        if (!session) return null
        return {
          sessionId: session.id,
          serverKey: session.key,
          root: session.root,
          editRoot:
            !sandboxed || (workDir !== undefined && isInsidePath(workDir, session.root))
              ? session.root
              : null,
          languageId: documentLanguageId(source.server, file, language),
          initializationOptions: substituteJson(
            source.server.initializationOptions ?? {},
            source.dir,
            session.root,
          ) as JsonObject,
        }
      }),
    )
    const alive = opened.filter(
      (info): info is LspSessionInfo => info !== null && this.sessions.has(info.sessionId),
    )
    if ((this.epochs.get(windowId) ?? 0) === epoch) return alive
    for (const info of alive) this.release(windowId, info.sessionId)
    return []
  }

  private async acquire(
    source: LanguageServerSource,
    pane: LanguageServerPane,
    file: string,
  ): Promise<Session | null> {
    const key = languageServerKey(source.extId, source.server.id)
    const owner = this.deps.sandbox.owner(pane.workspaceId)
    const root = findServerRoot(
      file,
      source.server.rootMarkers,
      this.deps.workDir(pane.workspaceId),
      this.deps.roots(),
    )
    const slotKey = [key, root, owner ?? HOST_SCOPE, pane.windowId].join('\n')
    let pending = this.starting.get(slotKey)
    if (!pending) {
      const existing = [...this.sessions.values()].find(
        (s) => s.slot === slotKey && s.stopping === null,
      )
      if (existing) {
        pending = Promise.resolve(existing)
      } else {
        const started = this.start(slotKey, key, pane, root, owner !== null).finally(() => {
          if (this.starting.get(slotKey) === started) this.starting.delete(slotKey)
        })
        this.starting.set(slotKey, started)
        pending = started
      }
    }
    const session = await pending
    if (!session || session.stopping !== null || !this.sessions.has(session.id)) return null
    session.refs += 1
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = null
    return session
  }

  private start(
    slotKey: string,
    key: string,
    pane: LanguageServerPane,
    root: string,
    sandboxed: boolean,
  ): Promise<Session | null> {
    return startServer({
      slotKey,
      key,
      pane,
      root,
      sandboxed,
      deps: this.deps,
      binaries: this.binaries,
      protocol: this.protocol,
      refusals: this.refusals,
      stopped: () => this.stopped,
      slot: (slotKey) => this.slot(slotKey),
      enabledSource: (key) => this.enabledSource(key),
      record: (key) => this.record(key),
      note: (key, entry) => this.note(key, entry),
      now: () => this.now(),
      changed: () => this.changed(),
    })
  }

  send(windowId: string, sessionId: unknown, message: unknown): void {
    this.protocol.send(windowId, sessionId, message)
  }

  release(windowId: string, sessionId: unknown): void {
    const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined
    if (!session || session.windowId !== windowId || session.stopping !== null) return
    session.refs = Math.max(0, session.refs - 1)
    if (session.refs > 0 || session.idleTimer) return
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null
      if (session.refs === 0) void this.stop(session, 'idle')
    }, this.deps.idleMs ?? LSP_IDLE_STOP_MS)
  }

  async restart(key: unknown): Promise<void> {
    if (typeof key !== 'string') return
    this.forgetSlots(key)
    this.record(key).sandboxProblem = null
    this.record(key).fetchFailure = null
    this.record(key).fetchHeld = false
    await Promise.all(this.live(key).map((session) => this.stop(session, 'restart')))
    this.changed()
  }

  dropWindow(windowId: string): void {
    this.epochs.set(windowId, (this.epochs.get(windowId) ?? 0) + 1)
    for (const session of [...this.sessions.values()]) {
      if (session.windowId === windowId) void this.stop(session, 'window')
    }
    const suffix = `\n${windowId}`
    for (const slotKey of [...this.slots.keys()]) {
      if (slotKey.endsWith(suffix)) this.slots.delete(slotKey)
    }
    for (const slotKey of [...this.refusals.keys()]) {
      if (slotKey.endsWith(suffix)) this.refusals.delete(slotKey)
    }
  }

  stopAll(): void {
    this.stopped = true
    for (const session of [...this.sessions.values()]) {
      this.protocol.stopWatching(session)
      if (session.stopping === null) {
        session.stopping = 'quit'
        if (session.initialized) {
          this.protocol.write(session, {
            jsonrpc: '2.0',
            id: `ostia-shutdown-${session.id}`,
            method: 'shutdown',
          })
          this.protocol.write(session, { jsonrpc: '2.0', method: 'exit' })
        }
      }
      this.kill(session, 'SIGTERM')
    }
  }

  private kill(session: Session, signal: NodeJS.Signals): void {
    try {
      session.proc.kill(signal)
    } catch {}
  }

  private stop(session: Session, reason: LspStopReason): Promise<void> {
    if (session.stopping !== null) return session.exited
    session.stopping = reason
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = null
    this.protocol.stopWatching(session)
    this.note(session.key, { at: this.now(), kind: 'stop', reason })
    const grace = this.deps.stopGraceMs ?? LSP_STOP_GRACE_MS
    if (!session.initialized) {
      this.kill(session, 'SIGTERM')
      session.killTimer = setTimeout(() => this.kill(session, 'SIGKILL'), grace)
      return session.exited
    }
    session.shutdownId = `ostia-shutdown-${session.id}`
    this.protocol.write(session, { jsonrpc: '2.0', id: session.shutdownId, method: 'shutdown' })
    session.killTimer = setTimeout(() => {
      this.kill(session, 'SIGTERM')
      session.killTimer = setTimeout(() => this.kill(session, 'SIGKILL'), grace)
    }, grace)
    return session.exited
  }

  private onExit(session: Session, code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.sessions.delete(session.id)) return
    this.protocol.stopWatching(session)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    if (session.killTimer) clearTimeout(session.killTimer)
    session.idleTimer = null
    session.killTimer = null
    const at = this.now()
    this.note(session.key, { at, kind: 'exit', code, signal })
    this.deps.log?.('lsp-exit', {
      server: session.key,
      code,
      signal,
      stopped: session.stopping ?? 'crash',
    })
    if (session.stopping === null) {
      const slot = this.slot(session.slot)
      const stable = at - session.startedAt >= LSP_STABLE_RUN_MS
      slot.restarts = stable ? 1 : slot.restarts + 1
      if (slot.restarts > LSP_MAX_RESTARTS) {
        slot.crashed = true
        this.note(session.key, { at, kind: 'crashed' })
      } else {
        const delayMs =
          (this.deps.restartDelayMs ?? LSP_RESTART_DELAY_MS) * 2 ** (slot.restarts - 1)
        slot.restartAt = at + delayMs
        this.note(session.key, {
          at,
          kind: 'restart',
          attempt: slot.restarts,
          limit: LSP_MAX_RESTARTS,
          delayMs,
        })
      }
    }
    session.resolveExited()
    this.deps.post(session.windowId, `lsp:exit:${session.id}`)
    this.changed()
  }
}
