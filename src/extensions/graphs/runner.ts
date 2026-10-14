import { join } from 'node:path'
import {
  type Clock,
  Engine,
  FileJournalStore,
  type GraphFile,
  type Host,
  type MemoryJournalStore,
  type NodeKind,
  type Output,
  type Problem,
  type RunView,
  type StartResult,
  connectorProblems,
  isEnded,
  missingKinds,
  parseInputs,
  resultErrors,
  routerNode,
  runView,
  waitNode,
} from '@aurigax-ai/graph'
import type { OstiaExtension } from '../sdk'
import { AGENT_LATE, AGENT_STOP, agentNode } from './agentNode'
import { NATIVE_CONNECTORS, SANDBOXED_CONNECTOR, ostiaConnectorNode } from './connectorHost'
import { ENABLED_FILE, EnableStore } from './enabled'
import { type GraphEntry, graphPath, listGraphs, readGraph } from './graphFiles'
import {
  approvalNode,
  chunkedRedact,
  ostiaCommandNode,
  ostiaNotifyNode,
  panelNotifier,
} from './humanNodes'
import type { EnabledGraph } from './triggers'

const OSTIA_TRIGGERS = ['manual', 'schedule', 'files', 'command', 'agent']
const SCRATCH = 'scratch'
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
>

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
}

export interface RunnerOptions {
  ext: GraphsExt
  dataDir: string | null
  clock: Clock
  store?: FileJournalStore | MemoryJournalStore
  changed: () => void
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

function fail(error: string, message: string): { ok: false; error: string; message: string } {
  return { ok: false, error, message }
}

export class GraphsRunner {
  readonly engine: Engine
  readonly enabled: EnableStore
  readonly host: Host
  private readonly store: FileJournalStore | MemoryJournalStore
  private readonly reports = new Map<string, Output>()
  private readonly lateTimers = new Map<string, () => void>()
  private workspaces = new Map<string, Workspace>()
  private connections: ConnectionName[] = []
  private mcpGranted = true
  private readonly panesOfGraphs = new Map<string, Set<string>>()

  constructor(private readonly opts: RunnerOptions) {
    const kinds: NodeKind[] = [
      agentNode({
        ext: opts.ext,
        clock: opts.clock,
        takeReport: (pane, runId) => this.takeReport(pane, runId),
        expectReport: (pane, runId, ms) => this.expectReport(pane, runId, ms),
      }),
      approvalNode({ ext: opts.ext, deliver: (event) => void this.engine.deliver(event) }),
      ostiaCommandNode(opts.ext),
      ostiaNotifyNode(opts.ext),
      ostiaConnectorNode(opts.ext, opts.clock, (id) => this.workspaces.get(id)?.sandboxed === true),
      routerNode,
      waitNode(() => opts.clock.now()),
    ]
    this.host = {
      name: 'ostia',
      contract: 1,
      kinds,
      triggers: OSTIA_TRIGGERS,
      clock: opts.clock,
      notify: panelNotifier(opts.ext),
      redact: chunkedRedact((texts) => opts.ext.redact(texts)),
    }
    this.store =
      opts.store ??
      new FileJournalStore(join(opts.dataDir ?? '/nonexistent', 'runs'), () => opts.clock.now())
    this.enabled = new EnableStore(opts.dataDir ? join(opts.dataDir, ENABLED_FILE) : null, () =>
      opts.clock.now(),
    )
    this.engine = new Engine({
      host: this.host,
      store: this.store,
      changed: (runId) => {
        this.notePanes(runId)
        opts.changed()
      },
    })
  }

  setConnections(list: ConnectionName[]): void {
    this.connections = list
  }

  setMcpGranted(granted: boolean): void {
    this.mcpGranted = granted
  }

  private notePanes(runId: string): void {
    const run = this.engine.run(runId)
    if (!run) return
    const key = `${run.state.scope}/${run.state.graphName}`
    const records = [...run.state.active.values(), ...run.state.history.values()]
    for (const record of records) {
      const pane = record.started?.pane
      if (typeof pane !== 'string') continue
      const panes = this.panesOfGraphs.get(key) ?? new Set<string>()
      panes.add(pane)
      this.panesOfGraphs.set(key, panes)
    }
  }

  ownPane(workspaceId: string, graph: string, pane: string): boolean {
    return this.panesOfGraphs.get(`${workspaceId}/${graph}`)?.has(pane) === true
  }

  enabledGraphs(): EnabledGraph[] {
    return [...this.workspaces.values()].flatMap((w) => {
      if (w.kind === SCRATCH) return []
      return listGraphs(w.workDir).flatMap((entry) => {
        const listing = this.listing(w.workspaceId, entry)
        const loaded = entry.loaded
        if (listing.state !== 'enabled' || listing.problems.length > 0 || !loaded) return []
        return [
          {
            workspaceId: w.workspaceId,
            workDir: w.workDir,
            name: entry.name,
            definition: { name: entry.name, graph: loaded.graph, fingerprint: loaded.fingerprint },
          },
        ]
      })
    })
  }

  fire(graph: EnabledGraph, payload: Output): StartResult {
    const listing = this.graph(graph.workspaceId, graph.name)
    const loaded = listing?.entry.loaded
    if (!listing || listing.state !== 'enabled' || !loaded) {
      return fail('not-enabled', `${graph.name} is not enabled`)
    }
    if (loaded.fingerprint !== graph.definition.fingerprint || listing.problems.length > 0) {
      return fail('changed', `${graph.name} changed since its triggers were set`)
    }
    return this.engine.start(graph.workspaceId, graph.definition, payload, {})
  }

  setWorkspaces(list: Workspace[]): void {
    this.workspaces = new Map(list.map((w) => [w.workspaceId, w]))
    for (const w of list) if (w.kind !== SCRATCH) this.engine.recover(w.workspaceId)
  }

  hasUnfinishedRuns(): boolean {
    if (this.engine.active().length > 0) return true
    return this.engine
      .summaries()
      .some((run) => run.status !== 'journal-version' && !isEnded(run.status))
  }

  workspace(id: string | undefined): Workspace | undefined {
    return id ? this.workspaces.get(id) : undefined
  }

  graphs(workspaceId: string): GraphListing[] | { error: string } {
    const w = this.workspaces.get(workspaceId)
    if (!w) return { error: 'unknown-workspace' }
    if (w.kind === SCRATCH) return { error: SCRATCH }
    return listGraphs(w.workDir).map((entry) => this.listing(workspaceId, entry))
  }

  private listing(workspaceId: string, entry: GraphEntry): GraphListing {
    if (!entry.loaded) {
      const record = this.enabled.record(workspaceId, entry.realPath)
      if (record) this.enabled.disable(workspaceId, entry.realPath, true)
      return { entry, state: 'invalid', problems: entry.problems }
    }
    const state = this.enabled.checked(workspaceId, entry.realPath, entry.loaded.fingerprint)
    const sandboxed = this.workspaces.get(workspaceId)?.sandboxed === true
    return {
      entry,
      state,
      problems: hostProblems(
        entry.loaded.graph,
        this.host,
        this.connections,
        sandboxed,
        this.mcpGranted,
      ),
    }
  }

  graph(workspaceId: string, name: string): GraphListing | null {
    const w = this.workspaces.get(workspaceId)
    const path = w ? graphPath(w.workDir, name) : null
    if (!w || !path) return null
    const entry = readGraph(w.workDir, path)
    if (!entry.loaded && entry.problems.some((p) => p.code === 'not-found')) return null
    return this.listing(workspaceId, entry)
  }

  enable(
    workspaceId: string,
    name: string,
    fingerprint: string,
  ): { ok: true } | { ok: false; error: string; message: string } {
    const w = this.workspaces.get(workspaceId)
    if (w?.kind === SCRATCH) return fail(SCRATCH, 'a scratch workspace has no graphs')
    const listing = this.graph(workspaceId, name)
    if (!listing?.entry.loaded) return fail('invalid', 'the graph does not validate')
    if (listing.entry.loaded.fingerprint !== fingerprint) {
      return fail('changed', 'the file changed since it was shown; look at it again')
    }
    if (listing.problems.length > 0)
      return fail(listing.problems[0].code, listing.problems[0].message)
    this.enabled.enable(workspaceId, listing.entry.realPath, fingerprint)
    this.opts.changed()
    return { ok: true }
  }

  disable(
    workspaceId: string,
    name: string,
  ): { ok: true } | { ok: false; error: string; message: string } {
    const listing = this.graph(workspaceId, name)
    if (!listing) return fail('unknown-graph', name)
    this.enabled.disable(workspaceId, listing.entry.realPath)
    this.opts.changed()
    return { ok: true }
  }

  start(
    workspaceId: string,
    name: string,
    how: { byAgent: boolean; pane?: string; inputs: string[]; inputJson?: string },
  ): StartResult {
    const w = this.workspaces.get(workspaceId)
    if (!w) return fail('unknown-workspace', 'no open workspace')
    if (w.kind === SCRATCH) return fail(SCRATCH, 'a scratch workspace has no graphs')
    const listing = this.graph(workspaceId, name)
    if (!listing) return fail('unknown-graph', `no graph ${name} in this workspace`)
    const loaded = listing.entry.loaded
    if (!loaded)
      return fail(listing.problems[0]?.code ?? 'invalid', listing.problems[0]?.message ?? 'invalid')
    if (listing.state !== 'enabled')
      return fail('not-enabled', `${name} is not enabled; the human enables it in the Graphs panel`)
    const manual = loaded.graph.on.find((t) => 'manual' in t) as
      | { manual: { agents?: boolean } }
      | undefined
    if (!manual) return fail('no-manual-trigger', `${name} has no manual trigger`)
    if (how.byAgent && manual.manual.agents !== true) {
      return fail(
        'not-for-agents',
        `${name} does not let agents start it (its manual trigger has no agents: true)`,
      )
    }
    if (listing.problems.length > 0)
      return fail(listing.problems[0].code, listing.problems[0].message)
    const input = parseInputs(loaded.graph, how.inputs, how.inputJson)
    if (!input.ok) return fail(input.problem.code, input.problem.message)
    const trigger: Output = {
      kind: 'manual',
      by: how.byAgent ? 'agent' : 'human',
      ...(how.pane ? { pane: how.pane } : {}),
    }
    return this.engine.start(
      workspaceId,
      { name, graph: loaded.graph, fingerprint: loaded.fingerprint },
      trigger,
      input.input,
    )
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
        void this.engine.deliver({ type: AGENT_LATE, pane, run: runId })
      }),
    )
  }

  async report(
    pane: string,
    raw: unknown,
    runId?: string,
  ): Promise<{ ok: true } | { ok: false; error: string; message: string }> {
    const waiting = this.engine
      .active()
      .flatMap((run) =>
        [
          ...run.waitingOn({ type: AGENT_STOP, pane }),
          ...run.waitingOn({ type: AGENT_LATE, pane, run: run.id }),
        ].map((node) => ({ run, node })),
      )
    const lateOf = (id: string) =>
      this.engine.waitingOn({ type: AGENT_LATE, pane, run: id }).length > 0
    const mine = runId ? waiting.filter((w) => w.run.id === runId) : waiting
    const runs = new Set(mine.map((w) => w.run.id))
    if (mine.length === 0) return fail('no-waiting-node', 'no graph node is waiting for this pane')
    if (runs.size > 1) {
      return fail(
        'ambiguous',
        `${runs.size} runs wait on this pane; pass --run <id> as the prompt says`,
      )
    }
    const found = mine[0] as (typeof mine)[number]
    const node = found.run.state.graph.nodes.find((n) => n.id === found.node)
    if (!node?.result) return fail('no-result', `${found.node} takes no result`)
    const errors = resultErrors(node.result, raw)
    await found.run.recordReport(found.node, errors.length === 0)
    if (errors.length > 0) return fail('bad-result', errors.join('; '))
    const key = reportKey(found.run.id, pane)
    if (lateOf(found.run.id)) {
      this.lateTimers.get(key)?.()
      this.lateTimers.delete(key)
      await this.engine.deliver({
        type: AGENT_LATE,
        pane,
        run: found.run.id,
        result: raw as Output,
      })
    } else {
      this.reports.set(key, raw as Output)
    }
    return { ok: true }
  }

  stopped(event: Output): Promise<number> {
    return this.engine.deliver({ type: AGENT_STOP, ...event })
  }

  runs(workspaceId: string, graph?: string) {
    return this.engine
      .summaries(workspaceId)
      .filter((s) => graph === undefined || s.graph === graph)
      .sort((a, b) => b.runId.localeCompare(a.runId))
  }

  view(workspaceId: string, runId: string): RunView | null {
    const live = this.engine.run(runId)
    const key = this.store.list(workspaceId).find((k) => k.runId === runId)
    if (!key) return null
    const stored = this.store.read(key)
    const graph =
      live?.state.graph ?? (stored?.definition as { graph?: GraphFile } | undefined)?.graph
    return stored && graph ? runView(key, graph, stored.lines) : null
  }

  async control(
    workspaceId: string,
    runId: string,
    action: string,
    node?: string,
  ): Promise<{ ok: true } | { ok: false; error: string; message: string }> {
    const run = this.engine.run(runId)
    if (!run || run.state.scope !== workspaceId) return fail('unknown-run', runId)
    if (action === 'pause') await run.pause()
    else if (action === 'resume') await run.resume()
    else if (action === 'cancel') await run.cancel()
    else if (action === 'retry') {
      if (!(await run.retry())) return fail('not-failed', 'only a failed run can be retried')
    } else if (action === 'rerun' || action === 'skip' || action === 'continue') {
      if (!node || !(await run.resolve(node, action)))
        return fail('not-interrupted', 'that node is not waiting for a choice')
    } else return fail('unknown-action', action)
    return { ok: true }
  }
}
