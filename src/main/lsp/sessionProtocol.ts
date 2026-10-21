import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ExtensionSettingValues } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import {
  configurationSection,
  overlaySettings,
  substituteJson,
} from '@aurigax-ai/ostia-extension-sdk/contract/languageServerConfig'
import {
  type JsonObject,
  type LanguageServerContribution,
  LSP_LOG_LINE_MAX,
  type LspLogEntry,
  type LspStopReason,
} from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import { isEqual } from 'es-toolkit'
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node'
import { type LogFields, redactSecrets } from '../diagnostics/appLog'
import type { TreeChange } from '../files/fileWatch'
import {
  type FileWatcher,
  parseFileWatchers,
  WATCHED_FILES_METHOD,
  watchedFileEvents,
} from '../files/watchedFiles'

const SESSION_ID_PATTERN = /^lsp-\d{1,12}$/
const MAX_TRACKED_REQUESTS = 2_000

export interface Session {
  id: string
  slot: string
  key: string
  signature: string
  windowId: string
  root: string
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
  fileWatchers: Map<string, FileWatcher[]>
  unwatch: (() => void) | null
  exited: Promise<void>
  resolveExited: () => void
}

interface SettingsSource {
  dir: string
  server: LanguageServerContribution
  settingValues: ExtensionSettingValues
}

function baseSettings(source: SettingsSource, root: string): JsonObject {
  const substituted = substituteJson(source.server.settings ?? {}, source.dir, root) as JsonObject
  return overlaySettings(substituted, source.server.settingPaths ?? {}, source.settingValues)
}

interface SessionProtocolDeps {
  sessions: Map<string, Session>
  record: (key: string) => { errors: Map<string, number> }
  note: (key: string, entry: LspLogEntry) => void
  now: () => number
  post: (windowId: string, channel: string, ...args: unknown[]) => void
  watchTree?: (root: string, onChange: (changes: TreeChange[]) => void) => (() => void) | null
  log?: (event: string, fields: LogFields) => void
  onExit: (session: Session, code: number | null, signal: NodeJS.Signals | null) => void
}

interface SessionStart {
  slotKey: string
  key: string
  signature: string
  source: SettingsSource
  pane: { windowId: string }
  root: string
  proc: ChildProcessWithoutNullStreams
  sandboxed: boolean
}

export class SessionProtocol {
  private seq = 0

  constructor(private readonly deps: SessionProtocolDeps) {}

  attach({ slotKey, key, signature, source, pane, root, proc, sandboxed }: SessionStart): Session {
    let resolveExited = (): void => {}
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve
    })
    const session: Session = {
      id: `lsp-${++this.seq}`,
      slot: slotKey,
      key,
      signature,
      windowId: pane.windowId,
      root,
      proc,
      writer: new StreamMessageWriter(proc.stdin),
      refs: 0,
      idleTimer: null,
      killTimer: null,
      startedAt: this.deps.now(),
      requests: new Map(),
      initialized: false,
      stopping: null,
      settings: baseSettings(source, root),
      shutdownId: null,
      fileWatchers: new Map(),
      unwatch: null,
      exited,
      resolveExited,
    }
    this.deps.sessions.set(session.id, session)
    this.deps.note(key, { at: this.deps.now(), kind: 'start', pid: proc.pid ?? 0, sandboxed })
    this.deps.log?.('lsp-start', { server: key, sandboxed })
    const reader = new StreamMessageReader(proc.stdout)
    reader.onError(() => {})
    reader.listen((message) => this.onServerMessage(session, message))
    session.writer.onError(() => {})
    proc.stdin.on('error', () => {})
    proc.stderr.on('data', (chunk: Buffer) => this.onStderr(key, chunk))
    proc.on('error', (err) => {
      this.deps.note(key, {
        at: this.deps.now(),
        kind: 'spawn-failed',
        text: redactSecrets(err.message).slice(0, LSP_LOG_LINE_MAX),
      })
      this.deps.onExit(session, null, null)
    })
    proc.on('exit', (code, signal) => this.deps.onExit(session, code, signal))
    return session
  }

  pushSettings(session: Session, source: SettingsSource): void {
    const settings = baseSettings(source, session.root)
    if (isEqual(settings, session.settings)) return
    session.settings = settings
    if (session.initialized) this.sendSettings(session)
  }

  private sendSettings(session: Session): void {
    this.write(session, {
      jsonrpc: '2.0',
      method: 'workspace/didChangeConfiguration',
      params: { settings: session.settings },
    })
  }

  onStderr(key: string, chunk: Buffer): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      const text = line.trimEnd()
      if (!text) continue
      this.deps.note(key, {
        at: this.deps.now(),
        kind: 'stderr',
        text: redactSecrets(text).slice(0, LSP_LOG_LINE_MAX),
      })
    }
  }

  write(session: Session, message: unknown): void {
    void session.writer
      .write(message as Parameters<StreamMessageWriter['write']>[0])
      .catch(() => {})
  }

  onServerMessage(session: Session, message: unknown): void {
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
      if (method === 'client/registerCapability') this.watchFiles(session, message.params)
      if (method === 'client/unregisterCapability') this.unwatchFiles(session, message.params)
    } else if (hasId) {
      if (id === session.shutdownId) {
        this.finishShutdown(session)
        return
      }
      const sent = session.requests.get(id)
      if (sent !== undefined) {
        session.requests.delete(id)
        if (message.error !== undefined) {
          const { errors } = this.deps.record(session.key)
          errors.set(sent, (errors.get(sent) ?? 0) + 1)
        } else if (sent === 'initialize') {
          this.noteInitialized(session, message.result)
        }
      }
    }
    this.deps.post(session.windowId, `lsp:msg:${session.id}`, message)
  }

  private watchFiles(session: Session, params: unknown): void {
    const registrations =
      isRecord(params) && Array.isArray(params.registrations) ? params.registrations : []
    for (const registration of registrations) {
      if (!isRecord(registration) || registration.method !== WATCHED_FILES_METHOD) continue
      if (typeof registration.id !== 'string') continue
      const watchers = parseFileWatchers(registration.registerOptions, session.root)
      if (watchers.length > 0) session.fileWatchers.set(registration.id, watchers)
    }
    if (session.fileWatchers.size === 0 || session.unwatch || session.stopping !== null) return
    session.unwatch =
      this.deps.watchTree?.(session.root, (changes) => this.onTreeChange(session, changes)) ?? null
  }

  private unwatchFiles(session: Session, params: unknown): void {
    const record = isRecord(params) ? params : {}
    const list = Array.isArray(record.unregisterations)
      ? record.unregisterations
      : Array.isArray(record.unregistrations)
        ? record.unregistrations
        : []
    for (const item of list) {
      if (isRecord(item) && typeof item.id === 'string') session.fileWatchers.delete(item.id)
    }
    if (session.fileWatchers.size === 0) this.stopWatching(session)
  }

  stopWatching(session: Session): void {
    session.unwatch?.()
    session.unwatch = null
  }

  private onTreeChange(session: Session, changes: TreeChange[]): void {
    if (!session.initialized || session.stopping !== null) return
    const events = watchedFileEvents(
      [...session.fileWatchers.values()].flat(),
      changes,
      session.root,
    )
    if (events.length === 0) return
    this.write(session, {
      jsonrpc: '2.0',
      method: WATCHED_FILES_METHOD,
      params: { changes: events },
    })
  }

  private noteInitialized(session: Session, result: unknown): void {
    const info = isRecord(result) && isRecord(result.serverInfo) ? result.serverInfo : {}
    const text = (value: unknown): string => (typeof value === 'string' ? value.slice(0, 80) : '')
    this.deps.note(session.key, {
      at: this.deps.now(),
      kind: 'initialized',
      name: text(info.name),
      version: text(info.version),
    })
  }

  send(windowId: string, sessionId: unknown, message: unknown): void {
    const session = typeof sessionId === 'string' ? this.deps.sessions.get(sessionId) : undefined
    if (!session) {
      if (typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId)) {
        this.deps.post(windowId, `lsp:exit:${sessionId}`)
      }
      return
    }
    if (session.windowId !== windowId || session.stopping !== null) return
    if (!isRecord(message)) return
    const { id, method } = message
    if (typeof method === 'string') {
      if (typeof id === 'string' || typeof id === 'number') {
        if (session.requests.size < MAX_TRACKED_REQUESTS) session.requests.set(id, method)
      } else if (method === 'initialized') {
        session.initialized = true
        this.write(session, message)
        if (Object.keys(session.settings).length > 0) this.sendSettings(session)
        return
      }
    }
    this.write(session, message)
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
}
