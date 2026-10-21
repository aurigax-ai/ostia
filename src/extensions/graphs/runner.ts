import { realpathSync } from 'node:fs'
import type { OstiaExtension } from '@aurigax-ai/ostia-extension-sdk'
import {
  type Clock,
  connectorProblems,
  type GraphFile,
  type Host,
  isEnded,
  missingKinds,
  type NodeKind,
  type Notice,
  type Output,
  type Problem,
  type RunSummary,
  type RuntimeClient,
  type RunView,
  resultErrors,
  routerNode,
  waitNode,
} from '@aurigax-ai/wire'
import { AGENT_LATE, AGENT_STOP, agentNode } from './agentNode'
import { NATIVE_CONNECTORS, ostiaConnectorNode, SANDBOXED_CONNECTOR } from './connectorHost'
import { type GraphEntry, graphPath, listGraphs, readGraph } from './graphFiles'
import {
  approvalNode,
  chunkedRedact,
  ostiaCommandNode,
  ostiaNotifyNode,
  panelNotifier,
} from './humanNodes'
import { type LinkExt, type LinkState, RuntimeLink } from './runtimeLink'
import { serveWorker } from './worker'

const OSTIA_TRIGGERS = ['manual', 'schedule', 'files', 'command', 'agent']
const WORKER_KINDS = ['agent', 'approval', 'command', 'notify', 'connector']
const SCRATCH = 'scratch'
const SHARED = 'shared-folder'
const SHARED_MESSAGE =
  'this folder is open in another workspace too; its graphs belong to the workspace that opened it first'

function realFolder(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const EVENTS = ['graph.changed', 'run.changed', 'node.changed', 'worker.changed']
const NEEDS_MCP =
  'Graphs may not call MCP servers yet: grant it MCP in Settings › Extensions › Graphs › Review permissions'

export type GraphsExt = Pick<
  OstiaExtension,
  | 'runAgent'
  | 'busSend'
  | 'wakePane'
  | 'listPanes'
  | 'ask'
  | 'exec'
  | 'notifyPanel'
  | 'redact'
  | 'mcpCall'
  | 'connection'
> &
  LinkExt

export interface ConnectionName {
  name: string
  kind: string
}

export interface Workspace {
  workspaceId: string
  workDir: string
  kind: string
  sandboxed?: boolean
}

export type GraphState = 'enabled' | 'changed' | 'not-enabled' | 'invalid'

export interface GraphListing {
  entry: GraphEntry
  state: GraphState
  problems: Problem[]
  skipped: number
  filesRefused: boolean
}

export interface Ceilings {
  steps: number
  runsPerHour: number
  parallel: number
  agents: number
  timeMs: number
}

export type TriggerPush =
  | { kind: 'command'; pane: string; exitCode: number }
  | { kind: 'agent'; pane: string; state: 'stopped' | 'waiting'; agent?: string }

export interface RunnerOptions {
  ext: GraphsExt
  clock: Clock
  changed: () => void
}

type Failure = { ok: false; error: string; message: string }
type Result<T extends object = object> = ({ ok: true } & T) | Failure

interface RemoteGraph {
  name: string
  state: GraphState
  fingerprint?: string
  skipped?: number
  filesRefused?: boolean
}

interface Waiting {
  scope: string
  runId: string
  node: string
  late: boolean
}

function hostProblems(
  graph: GraphFile,
  host: Pick<Host, 'kinds' | 'triggers' | 'name'>,
  connections: readonly ConnectionName[],
  sandboxed: boolean,
  mcpGranted: boolean,
): Problem[] {
  const problems = [
    ...missingKinds(graph, host),
    ...connectorProblems(graph, { mcp: true, native: NATIVE_CONNECTORS, connections }),
  ]
  for (const node of graph.nodes) {
    if (node.kind === 'connector' && sandboxed) {
      problems.push({ code: 'sandboxed', message: SANDBOXED_CONNECTOR, node: node.id })
    }
    const use = node.kind === 'connector' ? String(node.with?.use ?? '') : ''
    if (use.startsWith('mcp:') && !mcpGranted) {
      problems.push({ code: 'needs-mcp', message: NEEDS_MCP, node: node.id })
    }
  }
  for (const node of graph.nodes) {
    if (node.kind === 'approval' && node.with?.fields !== undefined) {
      problems.push({
        code: 'unsupported-with',
        message: `unsupported-with: approval fields (host: ${host.name})`,
        node: node.id,
      })
    }
  }
  return problems
}

function reportKey(runId: string, pane: string): string {
  return `${runId}\u0000${pane}`
}

function fail(error: string, message: string): Failure {
  return { ok: false, error, message }
}

function refused(err: unknown): Failure {
  const message = err instanceof Error ? err.message : String(err)
  const at = message.indexOf(': ')
  return at < 0 ? fail(message, message) : fail(message.slice(0, at), message.slice(at + 2))
}

function unfinished(run: RunSummary): boolean {
  return run.status !== 'journal-version' && !isEnded(run.status)
}

export class GraphsRunner {
  readonly host: Host
  readonly link: RuntimeLink
  private readonly kinds: NodeKind[]
  private readonly reports = new Map<string, Output>()
  private readonly lateTimers = new Map<string, () => void>()
  private readonly notify: (notice: Notice) => void
  private readonly redact: (texts: string[]) => Promise<string[] | null>
  private workspaces = new Map<string, Workspace>()
  private scopes = new Map<string, string>()
  private shared = new Set<string>()
  private owners = new Map<string, string>()
  private registered: {
    client: RuntimeClient | null
    folders: Map<string, { scope: string; sandboxed: boolean }>
    workerScopes: string
  } = { client: null, folders: new Map(), workerScopes: '' }
  private connections: ConnectionName[] = []
  private mcpGranted = true
  private ceilings: Ceilings | null = null

  constructor(private readonly opts: RunnerOptions) {
    this.redact = chunkedRedact((texts) => opts.ext.redact(texts))
    this.notify = panelNotifier(opts.ext)
    this.kinds = [
      agentNode({
        ext: opts.ext,
        clock: opts.clock,
        takeReport: (pane, runId) => this.takeReport(pane, runId),
        expectReport: (pane, runId, ms) => this.expectReport(pane, runId, ms),
      }),
      approvalNode({ ext: opts.ext, deliver: (ws, event) => void this.deliver(ws, event) }),
      ostiaCommandNode(opts.ext),
      ostiaNotifyNode(opts.ext),
      ostiaConnectorNode(opts.ext, opts.clock, (id) => this.workspaces.get(id)?.sandboxed === true),
    ]
    this.host = {
      name: 'ostia',
      contract: 1,
      kinds: [...this.kinds, routerNode, waitNode(() => opts.clock.now())],
      triggers: OSTIA_TRIGGERS,
      clock: opts.clock,
      notify: this.notify,
      redact: this.redact,
    }
    this.link = new RuntimeLink(opts.ext, (client) => this.ready(client), opts.changed)
  }

  get state(): LinkState {
    return this.link.state
  }

  private onEvent(event: string, params: unknown): void {
    const p = (params ?? {}) as { notice?: { title?: string; body?: string }; runId?: string }
    if (event === 'graph.changed' && p.notice?.title)
      this.notify({
        title: p.notice.title,
        ...(p.notice.body ? { body: p.notice.body } : {}),
        ...(p.runId ? { run: p.runId } : {}),
      })
    this.opts.changed()
  }

  private async ready(client: RuntimeClient): Promise<void> {
    for (const event of EVENTS) client.on(event, (params) => this.onEvent(event, params))
    serveWorker(client, this.kinds, {
      workspaceOf: (scope) => this.workspaceOf(scope),
      redact: this.redact,
    })
    await this.sync(client)
  }

  private workspaceOf(scope: string): string | null {
    for (const [workspaceId, s] of this.scopes) if (s === scope) return workspaceId
    return null
  }

  private open(): Workspace[] {
    return [...this.workspaces.values()].filter((w) => w.kind !== SCRATCH)
  }

  private openScopes(): string[] {
    return [...new Set(this.scopes.values())]
  }

  private async sync(client: RuntimeClient): Promise<void> {
    if (this.registered.client !== client)
      this.registered = { client, folders: new Map(), workerScopes: '' }
    const scopes = new Map<string, string>()
    const shared = new Set<string>()
    const byFolder = new Map<string, Workspace[]>()
    for (const w of this.open()) {
      const folder = realFolder(w.workDir)
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), w])
    }
    const owners = new Map<string, string>()
    for (const [folder, open] of byFolder) {
      const kept = open.find((w) => w.workspaceId === this.owners.get(folder))
      const owner = kept ?? (open[0] as Workspace)
      owners.set(folder, owner.workspaceId)
      for (const w of open) if (w !== owner) shared.add(w.workspaceId)
      scopes.set(owner.workspaceId, await this.register(client, folder, owner))
    }
    this.owners = owners
    this.scopes = scopes
    this.shared = shared
    for (const scope of this.openScopes()) {
      const w = this.workspaces.get(this.workspaceOf(scope) as string) as Workspace
      const valid = listGraphs(w.workDir).filter((e) => e.loaded)
      const remote = await client.call<RemoteGraph[]>('graphs.list', { scope })
      for (const entry of valid)
        if (remote.find((g) => g.name === entry.name)?.fingerprint !== entry.loaded?.fingerprint)
          await client.call('graphs.load', { scope, path: entry.path }).catch(() => {})
      for (const g of remote)
        if (!valid.some((e) => e.name === g.name))
          await client.call('graphs.unload', { scope, name: g.name }).catch(() => {})
    }
    const workerScopes = JSON.stringify([...this.openScopes()].sort())
    if (workerScopes !== this.registered.workerScopes) {
      await client.call('worker.register', { kinds: WORKER_KINDS, scopes: this.openScopes() })
      this.registered.workerScopes = workerScopes
    }
    if (this.ceilings) await client.call('runtime.ceilings', { ...this.ceilings })
  }

  private async register(client: RuntimeClient, folder: string, w: Workspace): Promise<string> {
    const sandboxed = w.sandboxed === true
    const known = this.registered.folders.get(folder)
    if (known && known.sandboxed === sandboxed) return known.scope
    const { scope } = await client.call<{ scope: string }>('scopes.register', {
      folder: w.workDir,
      sandboxed,
    })
    this.registered.folders.set(folder, { scope, sandboxed })
    return scope
  }

  async setWorkspaces(list: Workspace[]): Promise<void> {
    this.workspaces = new Map(list.map((w) => [w.workspaceId, w]))
    const client = await this.link.ensure()
    if (client) await this.sync(client).catch(() => {})
  }

  async setCeilings(ceilings: Ceilings): Promise<void> {
    this.ceilings = ceilings
    await this.link.call('runtime.ceilings', { ...ceilings }).catch(() => {})
  }

  setConnections(list: ConnectionName[]): void {
    this.connections = list
  }

  setMcpGranted(granted: boolean): void {
    this.mcpGranted = granted
  }

  workspace(id: string | undefined): Workspace | undefined {
    return id ? this.workspaces.get(id) : undefined
  }

  private scopeOf(workspaceId: string): string | null {
    return this.scopes.get(workspaceId) ?? null
  }

  private async remote(workspaceId: string): Promise<RemoteGraph[]> {
    const scope = this.scopeOf(workspaceId)
    if (!scope) return []
    return this.link.call<RemoteGraph[]>('graphs.list', { scope }).catch(() => [])
  }

  private listing(workspaceId: string, entry: GraphEntry, remote: RemoteGraph[]): GraphListing {
    if (!entry.loaded)
      return { entry, state: 'invalid', problems: entry.problems, skipped: 0, filesRefused: false }
    const found = remote.find((g) => g.name === entry.name)
    const state: GraphState =
      found && found.fingerprint === entry.loaded.fingerprint ? found.state : 'not-enabled'
    return {
      entry,
      state,
      problems: hostProblems(
        entry.loaded.graph,
        this.host,
        this.connections,
        this.workspaces.get(workspaceId)?.sandboxed === true,
        this.mcpGranted,
      ),
      skipped: found?.skipped ?? 0,
      filesRefused: found?.filesRefused === true,
    }
  }

  async graphs(workspaceId: string): Promise<GraphListing[] | { error: string; message?: string }> {
    const w = this.workspaces.get(workspaceId)
    if (!w) return { error: 'unknown-workspace' }
    if (w.kind === SCRATCH) return { error: SCRATCH }
    if (this.shared.has(workspaceId)) return { error: SHARED, message: SHARED_MESSAGE }
    const remote = await this.remote(workspaceId)
    return listGraphs(w.workDir).map((entry) => this.listing(workspaceId, entry, remote))
  }

  async graph(workspaceId: string, name: string): Promise<GraphListing | null> {
    const w = this.workspaces.get(workspaceId)
    const path = w ? graphPath(w.workDir, name) : null
    if (!w || !path) return null
    const entry = readGraph(w.workDir, path)
    if (!entry.loaded && entry.problems.some((p) => p.code === 'not-found')) return null
    const scope = this.scopeOf(workspaceId)
    if (scope && entry.loaded)
      await this.link.call('graphs.load', { scope, path: entry.path }).catch(() => {})
    return this.listing(workspaceId, entry, await this.remote(workspaceId))
  }

  async enable(workspaceId: string, name: string, fingerprint: string): Promise<Result> {
    const w = this.workspaces.get(workspaceId)
    if (w?.kind === SCRATCH) return fail(SCRATCH, 'a scratch workspace has no graphs')
    if (this.shared.has(workspaceId)) return fail(SHARED, SHARED_MESSAGE)
    const listing = await this.graph(workspaceId, name)
    if (!listing?.entry.loaded) return fail('invalid', 'the graph does not validate')
    if (listing.entry.loaded.fingerprint !== fingerprint)
      return fail('changed', 'the file changed since it was shown; look at it again')
    if (listing.problems[0]) return fail(listing.problems[0].code, listing.problems[0].message)
    const scope = this.scopeOf(workspaceId)
    if (!scope) return fail('unknown-workspace', 'no open workspace')
    try {
      await this.link.call('graphs.enable', { scope, name, fingerprint })
    } catch (err) {
      return refused(err)
    }
    this.opts.changed()
    return { ok: true }
  }

  async disable(workspaceId: string, name: string): Promise<Result> {
    const scope = this.scopeOf(workspaceId)
    if (!scope) return fail('unknown-graph', name)
    try {
      await this.link.call('graphs.disable', { scope, name })
    } catch (err) {
      return refused(err)
    }
    this.opts.changed()
    return { ok: true }
  }

  async start(
    workspaceId: string,
    name: string,
    how: { byAgent: boolean; pane?: string; inputs: string[]; inputJson?: string },
  ): Promise<Result<{ runId: string }> | Result<{ queued: true }>> {
    const w = this.workspaces.get(workspaceId)
    if (!w) return fail('unknown-workspace', 'no open workspace')
    if (w.kind === SCRATCH) return fail(SCRATCH, 'a scratch workspace has no graphs')
    if (this.shared.has(workspaceId)) return fail(SHARED, SHARED_MESSAGE)
    const listing = await this.graph(workspaceId, name)
    if (!listing) return fail('unknown-graph', `no graph ${name} in this workspace`)
    if (!listing.entry.loaded)
      return fail(listing.problems[0]?.code ?? 'invalid', listing.problems[0]?.message ?? 'invalid')
    if (listing.state !== 'enabled')
      return fail('not-enabled', `${name} is not enabled; the human enables it in the Graphs panel`)
    if (listing.problems[0]) return fail(listing.problems[0].code, listing.problems[0].message)
    let input: unknown
    if (how.inputJson !== undefined) {
      try {
        input = JSON.parse(how.inputJson)
      } catch {
        return fail('bad-input', '--input-json is not JSON')
      }
    }
    try {
      const res = await this.link.call<{ runId?: string; queued?: true }>('runs.start', {
        scope: this.scopeOf(workspaceId),
        name,
        inputs: how.inputs,
        by: how.byAgent ? 'agent' : 'human',
        ...(input !== undefined ? { input } : {}),
        ...(how.pane ? { pane: how.pane } : {}),
      })
      return res.runId ? { ok: true, runId: res.runId } : { ok: true, queued: true }
    } catch (err) {
      return refused(err)
    }
  }

  async runs(workspaceId: string, graph?: string): Promise<RunSummary[]> {
    const scope = this.scopeOf(workspaceId)
    if (!scope) return []
    const runs = await this.link.call<RunSummary[]>('runs.list', { scope }).catch(() => [])
    return runs
      .filter((s) => graph === undefined || s.graph === graph)
      .sort((a, b) => b.runId.localeCompare(a.runId))
  }

  async view(workspaceId: string, runId: string): Promise<RunView | null> {
    const scope = this.scopeOf(workspaceId)
    if (!scope) return null
    return this.link.call<RunView>('runs.show', { scope, runId }).catch(() => null)
  }

  async control(
    workspaceId: string,
    runId: string,
    action: string,
    node?: string,
  ): Promise<Result> {
    const scope = this.scopeOf(workspaceId)
    if (!scope) return fail('unknown-run', runId)
    try {
      const res = await this.link.call<{ ok: boolean }>('runs.control', {
        scope,
        runId,
        action,
        ...(node ? { node } : {}),
      })
      if (res.ok) return { ok: true }
      return action === 'retry'
        ? fail('not-failed', 'only a failed run can be retried')
        : fail('not-interrupted', 'that node is not waiting for a choice')
    } catch (err) {
      return refused(err)
    }
  }

  async hasUnfinishedRuns(): Promise<boolean> {
    for (const workspaceId of this.scopes.keys())
      if ((await this.runs(workspaceId)).some(unfinished)) return true
    return false
  }

  async needsLiveHost(): Promise<boolean> {
    for (const w of this.open()) {
      const listings = await this.graphs(w.workspaceId)
      if ('error' in listings) continue
      const live = listings.some(
        (l) => l.state === 'enabled' && l.entry.loaded?.graph.on.some((t) => !('manual' in t)),
      )
      if (live) return true
    }
    return false
  }

  async activeCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    for (const workspaceId of this.scopes.keys()) {
      const active = (await this.runs(workspaceId)).filter(unfinished).length
      if (active > 0) counts.set(workspaceId, active)
    }
    return counts
  }

  async deliver(workspaceId: string, event: Output): Promise<number> {
    const scope = this.scopeOf(workspaceId)
    if (!scope) return 0
    const res = await this.link
      .call<{ matched: number }>('events.push', { scope, event })
      .catch(() => ({ matched: 0 }))
    return res.matched
  }

  async trigger(workspaceId: string, trigger: TriggerPush): Promise<void> {
    const scope = this.scopeOf(workspaceId)
    if (scope) await this.link.call('events.push', { scope, trigger }).catch(() => {})
  }

  private async everyScope(event: Output): Promise<number> {
    let matched = 0
    for (const scope of this.openScopes()) {
      const res = await this.link
        .call<{ matched: number }>('events.push', { scope, event })
        .catch(() => ({ matched: 0 }))
      matched += res.matched
    }
    return matched
  }

  stopped(event: Output): Promise<number> {
    return this.everyScope({ type: AGENT_STOP, ...event })
  }

  private takeReport(pane: string, runId: string): Output | null {
    const key = reportKey(runId, pane)
    const report = this.reports.get(key) ?? null
    this.reports.delete(key)
    return report
  }

  private expectReport(pane: string, runId: string, ms: number): void {
    const key = reportKey(runId, pane)
    this.lateTimers.get(key)?.()
    this.lateTimers.set(
      key,
      this.opts.clock.setTimer(this.opts.clock.now() + ms, () => {
        this.lateTimers.delete(key)
        void this.everyScope({ type: AGENT_LATE, pane, run: runId })
      }),
    )
  }

  private async waitingFor(pane: string): Promise<Waiting[]> {
    const found: Waiting[] = []
    for (const scope of this.openScopes()) {
      const waits = (event: Output) =>
        this.link
          .call<{ runId: string; node: string }[]>('runs.waiting', { scope, event })
          .catch(() => [])
      for (const w of await waits({ type: AGENT_STOP, pane }))
        found.push({ scope, runId: w.runId, node: w.node, late: false })
      const runs = await this.link.call<RunSummary[]>('runs.list', { scope }).catch(() => [])
      for (const run of runs.filter(unfinished))
        for (const w of await waits({ type: AGENT_LATE, pane, run: run.runId }))
          found.push({ scope, runId: w.runId, node: w.node, late: true })
    }
    return found
  }

  async report(pane: string, raw: unknown, runId?: string): Promise<Result> {
    const waiting = await this.waitingFor(pane)
    const mine = runId ? waiting.filter((w) => w.runId === runId) : waiting
    const runs = new Set(mine.map((w) => w.runId))
    if (mine.length === 0) return fail('no-waiting-node', 'no graph node is waiting for this pane')
    if (runs.size > 1)
      return fail(
        'ambiguous',
        `${runs.size} runs wait on this pane; pass --run <id> as the prompt says`,
      )
    const found = mine[0] as Waiting
    const shown = await this.link
      .call<{ graph?: GraphFile }>('runs.show', { scope: found.scope, runId: found.runId })
      .catch(() => null)
    const node = shown?.graph?.nodes.find((n) => n.id === found.node)
    if (!node?.result) return fail('no-result', `${found.node} takes no result`)
    const errors = resultErrors(node.result, raw)
    await this.link
      .call('runs.report', {
        scope: found.scope,
        runId: found.runId,
        node: found.node,
        valid: errors.length === 0,
      })
      .catch(() => {})
    if (errors.length > 0) return fail('bad-result', errors.join('; '))
    const key = reportKey(found.runId, pane)
    if (found.late) {
      this.lateTimers.get(key)?.()
      this.lateTimers.delete(key)
      await this.link.call('events.push', {
        scope: found.scope,
        event: { type: AGENT_LATE, pane, run: found.runId, result: raw as Output },
      })
    } else {
      this.reports.set(key, raw as Output)
    }
    return { ok: true }
  }

  stop(): void {
    this.link.stop()
    for (const cancel of this.lateTimers.values()) cancel()
    this.lateTimers.clear()
  }
}
