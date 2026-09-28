import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { ALL_CAPABILITIES, type Capability } from '../shared/capabilities'
import {
  EXTENSION_EVENT_TYPES,
  EXTENSION_ICONS,
  type ExtensionCaller,
  type ExtensionCommandContribution,
  type ExtensionEventPayloads,
  type ExtensionEventType,
  type ExtensionIcon,
  type ExtensionInfo,
  type ExtensionOpenPanelRequest,
  type ExtensionPanelSource,
  type ExtensionResult,
  type ExtensionSidebarItem,
  type ExtensionStatus,
  SIDEBAR_TONES,
  type SidebarTone,
} from '../shared/extensions'
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
import { type PaneIdentity, registerExtension, removeExtension } from './idRegistry'

export const MAX_RESTARTS = 3
const MAX_SIDEBAR_ITEMS = 32
const SIDEBAR_TEXT_MAX = 80
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])

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
  panelOrigins: Set<string>
}

export interface ExtensionHostDeps {
  roots: ExtensionRoot[]
  store: ExtensionStore
  socketPath: () => string
  nodePath: string
  workDirForSession: (sessionId?: string) => string | undefined
  broadcast: (channel: string, payload: unknown) => void
  openPanelIn: (req: ExtensionOpenPanelRequest) => void
  notify: (n: { title: string; body?: string; from: string }) => void
  restartDelayMs?: number
  readyTimeoutMs?: number
  requestTimeoutMs?: number
  log?: (extId: string, line: string) => void
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
      return fail(
        typeof r.error === 'string' ? r.error : 'failed',
        typeof r.message === 'string' ? r.message : undefined,
      )
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
  private changes = new EventEmitter()

  constructor(private readonly deps: ExtensionHostDeps) {
    this.changes.setMaxListeners(0)
    const log = deps.log ?? ((id, line) => console.error(`[ext:${id}] ${line}`))
    for (const ext of discoverExtensions(deps.roots, (dir, error) => log(dir, error))) {
      this.runtimes.set(ext.manifest.id, {
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
        panelOrigins: new Set(),
      })
    }
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
    }
  }

  list(): ExtensionInfo[] {
    return [...this.runtimes.values()].map((rt) => this.info(rt))
  }

  sidebarItems(): ExtensionSidebarItem[] {
    return [...this.sidebar.values()]
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
    else if (this.active(rt) && rt.ext.manifest.contributes.sidebarItems) this.start(rt)
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

  startEager(): void {
    for (const rt of this.runtimes.values()) {
      if (this.active(rt) && rt.ext.manifest.contributes.sidebarItems) this.start(rt)
    }
  }

  private start(rt: Runtime): void {
    const main = rt.ext.manifest.main
    if (!main || rt.proc || rt.restartTimer || !this.active(rt)) return
    const id = rt.ext.manifest.id
    const identity = registerExtension(id)
    setCaps(identity.externalId, this.granted(rt))
    const mainPath = join(rt.ext.dir, main)
    const script = /\.(c|m)?js$/.test(main)
    const { PINE_PANE_ID: _pane, PINE_WORKSPACE: _workspace, ...inherited } = process.env
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
    if (rt.identity) dropIdentity(rt.identity.externalId)
    removeExtension(id)
    rt.identity = null
    rt.conn = null
    rt.ready.clear()
    rt.subscriptions.clear()
    rt.panelOrigins.clear()
    this.clearSidebarOf(id)
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
    this.changed(rt)
  }

  private stop(rt: Runtime): void {
    rt.stopping = true
    if (rt.restartTimer) clearTimeout(rt.restartTimer)
    rt.restartTimer = null
    rt.proc?.kill('SIGTERM')
    if (!rt.proc) rt.state = 'idle'
    this.clearSidebarOf(rt.ext.manifest.id)
  }

  stopAll(): void {
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
      const raw = await withTimeout(
        conn.sendRequest('ext.command', { command, args: args ?? null, caller }),
        this.deps.requestTimeoutMs ?? 30_000,
        `${extId} ${command}`,
      )
      return normalizeResult(raw)
    } catch (err) {
      return fail('extension-unavailable', (err as Error).message)
    }
  }

  userCaller(sessionId: string | null, extra: Partial<ExtensionCaller> = {}): ExtensionCaller {
    const caller: ExtensionCaller = { kind: 'user', capabilities: [...ALL_CAPABILITIES], ...extra }
    if (sessionId) {
      caller.sessionId = sessionId
      const workDir = this.deps.workDirForSession(sessionId)
      if (workDir) caller.workDir = workDir
    }
    return caller
  }

  paneCaller(identity: PaneIdentity): ExtensionCaller {
    const caller: ExtensionCaller = {
      kind: 'pane',
      paneId: identity.externalId,
      sessionId: identity.sessionId,
      capabilities: capsOf(identity.externalId),
    }
    const workDir = this.deps.workDirForSession(identity.sessionId)
    if (workDir) caller.workDir = workDir
    return caller
  }

  commandCapabilities(extId: string, command: string): Capability[] {
    const rt = this.runtimes.get(extId)
    return rt ? (this.commandsOf(rt).find((c) => c.id === command)?.capabilities ?? []) : []
  }

  async resolvePanel(
    extId: string,
    context: { sessionId: string; locale: string },
  ): Promise<ExtensionPanelSource> {
    const rt = this.runtimes.get(extId)
    if (!rt || !this.active(rt)) return { ok: false, error: 'extension-disabled' }
    const panel = rt.ext.manifest.contributes.panel
    if (!panel) return { ok: false, error: 'no-panel' }
    if (panel.entry !== 'url') {
      if (rt.ext.manifest.main) this.start(rt)
      return { ok: true, src: pathToFileURL(join(rt.ext.dir, panel.entry)).href }
    }
    try {
      const conn = await this.connected(rt)
      const caller = this.userCaller(context.sessionId, { locale: context.locale })
      const res = await withTimeout(
        conn.sendRequest<{ url?: unknown }>('ext.panel', { caller }),
        this.deps.requestTimeoutMs ?? 30_000,
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
    const sessionId = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : undefined
    const slot = `${extId}\u0000${sessionId ?? ''}\u0000${key}`
    const text = typeof p.text === 'string' ? p.text.trim().slice(0, SIDEBAR_TEXT_MAX) : ''
    if (!text) {
      if (this.sidebar.delete(slot)) this.sidebarChanged()
      return { ok: true }
    }
    const count = [...this.sidebar.values()].filter((i) => i.extId === extId).length
    if (!this.sidebar.has(slot) && count >= MAX_SIDEBAR_ITEMS) return fail('too-many-items')
    const tone = SIDEBAR_TONES.includes(p.tone as SidebarTone) ? (p.tone as SidebarTone) : 'neutral'
    const item: ExtensionSidebarItem = { extId, key, text, tone }
    if (sessionId) item.sessionId = sessionId
    if (EXTENSION_ICONS.includes(p.icon as ExtensionIcon)) item.icon = p.icon as ExtensionIcon
    this.sidebar.set(slot, item)
    this.sidebarChanged()
    return { ok: true }
  }

  notify(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    const p = (params ?? {}) as { title?: unknown; body?: unknown }
    const title = typeof p.title === 'string' ? p.title.trim().slice(0, 256) : ''
    if (!title) return fail('missing-title')
    const body = typeof p.body === 'string' && p.body.trim() ? p.body.slice(0, 1024) : undefined
    this.deps.notify({ title, body, from: `extension:${rt.ext.manifest.id}` })
    return { ok: true }
  }

  openPanel(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.runtimeOf(identity, conn)
    if (!rt.ext.manifest.contributes.panel) return fail('not-contributed', 'no panel in manifest')
    const sessionId = (params as { sessionId?: unknown })?.sessionId
    const req: ExtensionOpenPanelRequest = { extId: rt.ext.manifest.id }
    if (typeof sessionId === 'string' && sessionId) req.sessionId = sessionId
    this.deps.openPanelIn(req)
    return { ok: true }
  }

  listForAgents() {
    return this.list()
      .filter((e) => e.enabled)
      .map((e) => ({ id: e.id, name: e.name, status: e.status, commands: e.commands }))
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
}
