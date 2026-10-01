import { type ChildProcessWithoutNullStreams, spawn as spawnProcess } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node'
import { languageForPath } from '../shared/editorLanguages'
import type { ExtensionSettingValues } from '../shared/extensions'
import {
  type JsonObject,
  LSP_LOG_LINE_MAX,
  LSP_LOG_MAX_ENTRIES,
  type LanguageServerContribution,
  type LanguageServerInfo,
  type LanguageServerSandboxProblem,
  type LanguageServerStatus,
  type LspLog,
  type LspLogEntry,
  type LspSessionInfo,
  type LspStopReason,
  configurationSection,
  documentLanguageId,
  isProgramRun,
  languageServerCommand,
  languageServerFeature,
  languageServerKey,
  overlaySettings,
  substituteJson,
  substitutePlaceholders,
} from '../shared/languageServers'
import { quoteArgv } from '../shared/shellQuote'
import { type LogFields, redactSecrets } from './appLog'
import type { Requirement } from './systemRequirements'

export const LSP_IDLE_STOP_MS = 60_000
export const LSP_MAX_RESTARTS = 5
export const LSP_RESTART_DELAY_MS = 500
export const LSP_STABLE_RUN_MS = 60_000
export const LSP_STOP_GRACE_MS = 2_000
const HOST_SCOPE = 'host'
const MAX_TRACKED_REQUESTS = 2_000
const PROGRAM_PLATFORMS: NodeJS.Platform[] = ['linux', 'darwin', 'win32']

export interface LanguageServerSource {
  extId: string
  extName: string
  dir: string
  builtin: boolean
  state: 'on' | 'off' | 'pending'
  server: LanguageServerContribution
  settingValues: ExtensionSettingValues
}

export interface LanguageServerPane {
  windowId: string
  workspaceId: string
}

export interface LanguageServerSandbox {
  owner: (workspaceId: string) => string | null
  readable: (workspaceId: string, path: string) => boolean
  wrap: (workspaceId: string, command: string, extraReads: string[]) => Promise<string>
  env: (workspaceId: string, env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
}

export type SpawnServer = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: false },
) => ChildProcessWithoutNullStreams

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
  registerRequirements: (feature: string, requirements: Requirement[], label?: string) => void
  post: (windowId: string, channel: string, ...args: unknown[]) => void
  changed: (list: LanguageServerInfo[]) => void
  log?: (event: string, fields: LogFields) => void
  spawn?: SpawnServer
  idleMs?: number
  restartDelayMs?: number
  stopGraceMs?: number
  now?: () => number
}

interface Session {
  id: string
  slot: string
  key: string
  signature: string
  windowId: string
  workspaceId: string
  root: string
  dir: string
  proc: ChildProcessWithoutNullStreams
  writer: StreamMessageWriter
  refs: number
  idleTimer: ReturnType<typeof setTimeout> | null
  killTimer: ReturnType<typeof setTimeout> | null
  startedAt: number
  requests: Map<string | number, string>
  initialized: boolean
  stopping: LspStopReason | null
  settings: JsonObject
  shutdownId: string | null
  exited: Promise<void>
  resolveExited: () => void
}

interface Slot {
  restarts: number
  restartAt: number
  crashed: boolean
}

interface ServerRecord {
  entries: LspLogEntry[]
  errors: Map<string, number>
  sandboxProblem: { problem: LanguageServerSandboxProblem; detail: string } | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInside(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith('/') ? base : `${base}/`)
}

export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('PINE_') || name === 'ELECTRON_RUN_AS_NODE') continue
    out[name] = value
  }
  return out
}

export function findServerRoot(
  file: string,
  markers: readonly string[],
  workDir: string | undefined,
  roots: readonly string[],
  exists: (path: string) => boolean = existsSync,
): string {
  const start = dirname(file)
  const inWorkspace = workDir !== undefined && isInside(start, workDir)
  const fallback = inWorkspace ? workDir : start
  if (markers.length === 0) return fallback
  const boundary = inWorkspace
    ? workDir
    : (roots.filter((root) => isInside(start, root)).sort((a, b) => b.length - a.length)[0] ??
      start)
  let dir = start
  for (;;) {
    if (markers.some((marker) => exists(join(dir, marker)))) return dir
    const parent = dirname(dir)
    if (dir === boundary || parent === dir || !isInside(parent, boundary)) return fallback
    dir = parent
  }
}

export function confinedScript(extensionDir: string, script: string): string | null {
  try {
    const dir = realpathSync(extensionDir)
    const file = realpathSync(join(extensionDir, script))
    if (file === dir || !isInside(file, dir)) return null
    return statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

function sourceSignature(source: LanguageServerSource): string {
  return JSON.stringify([source.dir, source.server.run, source.server.initializationOptions ?? {}])
}

function baseSettings(source: LanguageServerSource, root: string): JsonObject {
  const substituted = substituteJson(source.server.settings ?? {}, source.dir, root) as JsonObject
  return overlaySettings(substituted, source.server.settingPaths ?? {}, source.settingValues)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class LanguageServers {
  private readonly sessions = new Map<string, Session>()
  private readonly starting = new Map<string, Promise<Session | null>>()
  private readonly slots = new Map<string, Slot>()
  private readonly records = new Map<string, ServerRecord>()
  private registered = new Set<string>()
  private seq = 0
  private stopped = false

  constructor(private readonly deps: LanguageServersDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private record(key: string): ServerRecord {
    let record = this.records.get(key)
    if (!record) {
      record = { entries: [], errors: new Map(), sandboxProblem: null }
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

  private status(source: LanguageServerSource, key: string): LanguageServerStatus {
    if (source.state === 'pending') return 'pending-approval'
    if (source.state === 'off') return 'off'
    const { run } = source.server
    if (isProgramRun(run) && this.deps.findProgram(run.program) === null) return 'program-missing'
    if (this.live(key).length > 0) return 'running'
    const prefix = `${key}\n`
    for (const [slotKey, slot] of this.slots) {
      if (slot.crashed && slotKey.startsWith(prefix)) return 'crashed'
    }
    return this.record(key).sandboxProblem ? 'sandbox-unavailable' : 'idle'
  }

  servers(): LanguageServerInfo[] {
    return this.deps.sources().map((source) => {
      const key = languageServerKey(source.extId, source.server.id)
      const { run } = source.server
      const status = this.status(source, key)
      const sandbox = this.record(key).sandboxProblem
      return {
        key,
        extId: source.extId,
        extName: source.extName,
        serverId: source.server.id,
        name: source.server.name,
        languages: source.server.languages,
        kind: isProgramRun(run) ? 'program' : 'bundled',
        command: languageServerCommand(run),
        enabled: source.state === 'on',
        status,
        folders: new Set(this.live(key).map((s) => s.root)).size,
        ...(isProgramRun(run)
          ? { program: run.program, requirement: languageServerFeature(key) }
          : {}),
        ...(status === 'sandbox-unavailable' && sandbox
          ? { sandboxProblem: sandbox.problem, sandboxDetail: sandbox.detail }
          : {}),
      }
    })
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
    for (const source of sources) {
      const key = languageServerKey(source.extId, source.server.id)
      if (source.state === 'on') on.set(key, source)
      const { run } = source.server
      if (!isProgramRun(run)) continue
      const feature = languageServerFeature(key)
      programs.add(feature)
      this.deps.registerRequirements(
        feature,
        [
          {
            program: run.program,
            package: run.package ?? run.program,
            platforms: PROGRAM_PLATFORMS,
          },
        ],
        source.server.name,
      )
    }
    for (const feature of this.registered) {
      if (!programs.has(feature)) this.deps.registerRequirements(feature, [])
    }
    this.registered = programs
    for (const session of [...this.sessions.values()]) {
      if (session.stopping !== null) continue
      const source = on.get(session.key)
      if (!source) void this.stop(session, 'off')
      else if (sourceSignature(source) !== session.signature) void this.stop(session, 'restart')
      else this.pushSettings(session, source)
    }
    for (const key of this.records.keys()) {
      if (on.has(key)) continue
      this.forgetSlots(key)
      this.record(key).sandboxProblem = null
    }
    this.changed()
  }

  private forgetSlots(key: string): void {
    const prefix = `${key}\n`
    for (const slotKey of [...this.slots.keys()]) {
      if (slotKey.startsWith(prefix)) this.slots.delete(slotKey)
    }
  }

  private pushSettings(session: Session, source: LanguageServerSource): void {
    const settings = baseSettings(source, session.root)
    if (JSON.stringify(settings) === JSON.stringify(session.settings)) return
    session.settings = settings
    if (!session.initialized) return
    this.write(session, {
      jsonrpc: '2.0',
      method: 'workspace/didChangeConfiguration',
      params: { settings },
    })
  }

  async open(windowId: string, paneId: unknown, filePath: unknown): Promise<LspSessionInfo[]> {
    if (this.stopped || typeof paneId !== 'string' || typeof filePath !== 'string') return []
    const pane = this.deps.pane(paneId)
    if (!pane || pane.windowId !== windowId) return []
    const file = this.deps.confine(filePath)
    if (file === null) return []
    const language = languageForPath(file)
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
          languageId: documentLanguageId(source.server, file, language),
          initializationOptions: substituteJson(
            source.server.initializationOptions ?? {},
            source.dir,
            session.root,
          ) as JsonObject,
        }
      }),
    )
    return opened.filter((info): info is LspSessionInfo => info !== null)
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

  private async start(
    slotKey: string,
    key: string,
    pane: LanguageServerPane,
    root: string,
    sandboxed: boolean,
  ): Promise<Session | null> {
    const slot = this.slot(slotKey)
    if (slot.crashed) return null
    const wait = slot.restartAt - this.now()
    if (wait > 0) await sleep(wait)
    if (this.stopped || this.slot(slotKey).crashed) return null
    const source = this.deps
      .sources()
      .find((s) => s.state === 'on' && languageServerKey(s.extId, s.server.id) === key)
    if (!source) return null
    const { run } = source.server
    const env = scrubbedEnv(this.deps.env())
    let command: string
    const args: string[] = []
    if (isProgramRun(run)) {
      const program = this.deps.findProgram(run.program)
      if (program === null) return null
      command = program
    } else {
      const script = confinedScript(source.dir, run.node)
      if (script === null) {
        this.note(key, { at: this.now(), kind: 'spawn-failed', text: 'script-outside-extension' })
        return null
      }
      command = this.deps.nodePath
      args.push(script)
      env.ELECTRON_RUN_AS_NODE = '1'
    }
    args.push(...run.args.map((arg) => substitutePlaceholders(arg, source.dir, root)))
    const record = this.record(key)
    let spawnCommand = command
    let spawnArgs = args
    let spawnEnv = env
    if (sandboxed) {
      const { sandbox } = this.deps
      const refuse = (problem: LanguageServerSandboxProblem, detail: string): null => {
        record.sandboxProblem = { problem, detail }
        this.deps.log?.('lsp-sandbox-refused', { server: key, problem })
        this.changed()
        return null
      }
      if (isProgramRun(run) && !sandbox.readable(pane.workspaceId, command)) {
        return refuse('program-unreadable', dirname(command))
      }
      if (!sandbox.readable(pane.workspaceId, root)) return refuse('folder-unreadable', root)
      try {
        const wrapped = await sandbox.wrap(
          pane.workspaceId,
          quoteArgv([command, ...args]),
          isProgramRun(run) || source.builtin ? [] : [source.dir],
        )
        spawnCommand = '/bin/sh'
        spawnArgs = ['-c', wrapped]
        spawnEnv = sandbox.env(pane.workspaceId, env)
      } catch (err) {
        return refuse('wrap-failed', err instanceof Error ? err.message : String(err))
      }
      if (this.stopped) return null
    }
    record.sandboxProblem = null
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = (this.deps.spawn ?? spawnProcess)(spawnCommand, spawnArgs, {
        cwd: root,
        env: spawnEnv,
        shell: false,
      })
    } catch (err) {
      this.note(key, {
        at: this.now(),
        kind: 'spawn-failed',
        text: redactSecrets(err instanceof Error ? err.message : String(err)).slice(
          0,
          LSP_LOG_LINE_MAX,
        ),
      })
      return null
    }
    let resolveExited = (): void => {}
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve
    })
    const session: Session = {
      id: `lsp-${++this.seq}`,
      slot: slotKey,
      key,
      signature: sourceSignature(source),
      windowId: pane.windowId,
      workspaceId: pane.workspaceId,
      root,
      dir: source.dir,
      proc,
      writer: new StreamMessageWriter(proc.stdin),
      refs: 0,
      idleTimer: null,
      killTimer: null,
      startedAt: this.now(),
      requests: new Map(),
      initialized: false,
      stopping: null,
      settings: baseSettings(source, root),
      shutdownId: null,
      exited,
      resolveExited,
    }
    this.sessions.set(session.id, session)
    this.note(key, { at: this.now(), kind: 'start', pid: proc.pid ?? 0, sandboxed })
    this.deps.log?.('lsp-start', { server: key, sandboxed })
    const reader = new StreamMessageReader(proc.stdout)
    reader.onError(() => {})
    reader.listen((message) => this.onServerMessage(session, message))
    session.writer.onError(() => {})
    proc.stdin.on('error', () => {})
    proc.stderr.on('data', (chunk: Buffer) => this.onStderr(key, chunk))
    proc.on('error', (err) => {
      this.note(key, {
        at: this.now(),
        kind: 'spawn-failed',
        text: redactSecrets(err.message).slice(0, LSP_LOG_LINE_MAX),
      })
      this.onExit(session, null, null)
    })
    proc.on('exit', (code, signal) => this.onExit(session, code, signal))
    this.changed()
    return session
  }

  private onStderr(key: string, chunk: Buffer): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      const text = line.trimEnd()
      if (!text) continue
      this.note(key, {
        at: this.now(),
        kind: 'stderr',
        text: redactSecrets(text).slice(0, LSP_LOG_LINE_MAX),
      })
    }
  }

  private write(session: Session, message: unknown): void {
    void session.writer
      .write(message as Parameters<StreamMessageWriter['write']>[0])
      .catch(() => {})
  }

  private onServerMessage(session: Session, message: unknown): void {
    if (!isRecord(message)) return
    const { id, method } = message
    const hasId = typeof id === 'string' || typeof id === 'number'
    if (typeof method === 'string') {
      if (method === 'workspace/configuration' && hasId) {
        const params = isRecord(message.params) ? message.params : {}
        const items = Array.isArray(params.items) ? params.items : []
        const result = items.map((item) =>
          configurationSection(session.settings, isRecord(item) ? item.section : undefined),
        )
        this.write(session, { jsonrpc: '2.0', id, result })
        return
      }
    } else if (hasId) {
      if (id === session.shutdownId) {
        this.finishShutdown(session)
        return
      }
      const sent = session.requests.get(id)
      if (sent !== undefined) {
        session.requests.delete(id)
        if (message.error !== undefined) {
          const { errors } = this.record(session.key)
          errors.set(sent, (errors.get(sent) ?? 0) + 1)
        } else if (sent === 'initialize') {
          this.noteInitialized(session, message.result)
        }
      }
    }
    this.deps.post(session.windowId, `lsp:msg:${session.id}`, message)
  }

  private noteInitialized(session: Session, result: unknown): void {
    const info = isRecord(result) && isRecord(result.serverInfo) ? result.serverInfo : {}
    const text = (value: unknown): string => (typeof value === 'string' ? value.slice(0, 80) : '')
    this.note(session.key, {
      at: this.now(),
      kind: 'initialized',
      name: text(info.name),
      version: text(info.version),
    })
  }

  send(windowId: string, sessionId: unknown, message: unknown): void {
    const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined
    if (!session || session.windowId !== windowId || session.stopping !== null) return
    if (!isRecord(message)) return
    const { id, method } = message
    if (typeof method === 'string') {
      if (typeof id === 'string' || typeof id === 'number') {
        if (session.requests.size < MAX_TRACKED_REQUESTS) session.requests.set(id, method)
      } else if (method === 'initialized') {
        session.initialized = true
      }
    }
    this.write(session, message)
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
    await Promise.all(this.live(key).map((session) => this.stop(session, 'restart')))
    this.changed()
  }

  dropWindow(windowId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.windowId === windowId) void this.stop(session, 'window')
    }
    const suffix = `\n${windowId}`
    for (const slotKey of [...this.slots.keys()]) {
      if (slotKey.endsWith(suffix)) this.slots.delete(slotKey)
    }
  }

  stopAll(): void {
    this.stopped = true
    for (const session of [...this.sessions.values()]) {
      if (session.stopping === null) {
        session.stopping = 'quit'
        if (session.initialized) {
          this.write(session, {
            jsonrpc: '2.0',
            id: `pine-shutdown-${session.id}`,
            method: 'shutdown',
          })
          this.write(session, { jsonrpc: '2.0', method: 'exit' })
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
    this.note(session.key, { at: this.now(), kind: 'stop', reason })
    const grace = this.deps.stopGraceMs ?? LSP_STOP_GRACE_MS
    if (!session.initialized) {
      this.kill(session, 'SIGTERM')
      session.killTimer = setTimeout(() => this.kill(session, 'SIGKILL'), grace)
      return session.exited
    }
    session.shutdownId = `pine-shutdown-${session.id}`
    this.write(session, { jsonrpc: '2.0', id: session.shutdownId, method: 'shutdown' })
    session.killTimer = setTimeout(() => {
      this.kill(session, 'SIGTERM')
      session.killTimer = setTimeout(() => this.kill(session, 'SIGKILL'), grace)
    }, grace)
    return session.exited
  }

  private finishShutdown(session: Session): void {
    session.shutdownId = null
    void session.writer
      .write({ jsonrpc: '2.0', method: 'exit' } as Parameters<StreamMessageWriter['write']>[0])
      .catch(() => {})
      .then(() => {
        try {
          session.proc.stdin.end()
        } catch {}
      })
  }

  private onExit(session: Session, code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.sessions.delete(session.id)) return
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
