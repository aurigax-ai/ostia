import { join } from 'node:path'
import type { Clock, Host, NodeKind, Output } from '../../../graph-engine/src/engine/contract'
import { Engine, type StartResult, missingKinds } from '../../../graph-engine/src/engine/engine'
import { FileJournalStore } from '../../../graph-engine/src/engine/fileStore'
import { parseInputs } from '../../../graph-engine/src/engine/inputs'
import type { MemoryJournalStore } from '../../../graph-engine/src/engine/journal'
import { type RunView, runView } from '../../../graph-engine/src/engine/summary'
import type { GraphFile, Problem } from '../../../graph-engine/src/format/model'
import { resultErrors } from '../../../graph-engine/src/format/resultSchema'
import { routerNode, waitNode } from '../../../graph-engine/src/kinds/smallKinds'
import type { OstiaExtension } from '../sdk'
import { AGENT_LATE, AGENT_STOP, agentNode } from './agentNode'
import { ENABLED_FILE, EnableStore } from './enabled'
import { type GraphEntry, graphPath, listGraphs, readGraph } from './graphFiles'
import { approvalNode, ostiaCommandNode, ostiaNotifyNode, panelNotifier } from './humanNodes'

const OSTIA_TRIGGERS = ['manual']
const SCRATCH = 'scratch'

export type GraphsExt = Pick<
  OstiaExtension,
  'runAgent' | 'busSend' | 'wakePane' | 'listPanes' | 'ask' | 'exec' | 'notifyPanel' | 'redact'
>

export interface Workspace {
  workspaceId: string
  workDir: string
  kind: string
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
): Problem[] {
  const problems = missingKinds(graph, host)
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

  constructor(private readonly opts: RunnerOptions) {
    const kinds: NodeKind[] = [
      agentNode({
        ext: opts.ext,
        clock: opts.clock,
        takeReport: (pane) => this.takeReport(pane),
        expectReport: (pane, ms) => this.expectReport(pane, ms),
      }),
      approvalNode({ ext: opts.ext, deliver: (event) => void this.engine.deliver(event) }),
      ostiaCommandNode(opts.ext),
      ostiaNotifyNode(opts.ext),
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
      redact: async (texts) => opts.ext.redact(texts),
    }
    this.store =
      opts.store ??
      new FileJournalStore(join(opts.dataDir ?? '/nonexistent', 'runs'), () => opts.clock.now())
    this.enabled = new EnableStore(opts.dataDir ? join(opts.dataDir, ENABLED_FILE) : null, () =>
      opts.clock.now(),
    )
    this.engine = new Engine({ host: this.host, store: this.store, changed: () => opts.changed() })
  }

  setWorkspaces(list: Workspace[]): void {
    this.workspaces = new Map(list.map((w) => [w.workspaceId, w]))
    for (const w of list) if (w.kind !== SCRATCH) this.engine.recover(w.workspaceId)
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
    return { entry, state, problems: hostProblems(entry.loaded.graph, this.host) }
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

  private takeReport(pane: string): Output | null {
    const report = this.reports.get(pane) ?? null
    this.reports.delete(pane)
    return report
  }

  private expectReport(pane: string, ms: number): void {
    this.lateTimers.get(pane)?.()
    this.lateTimers.set(
      pane,
      this.opts.clock.setTimer(this.opts.clock.now() + ms, () => {
        this.lateTimers.delete(pane)
        void this.engine.deliver({ type: AGENT_LATE, pane })
      }),
    )
  }

  async report(
    pane: string,
    raw: unknown,
  ): Promise<{ ok: true } | { ok: false; error: string; message: string }> {
    const waiting = [
      ...this.engine.waitingOn({ type: AGENT_STOP, pane }),
      ...this.engine.waitingOn({ type: AGENT_LATE, pane }),
    ]
    const found = waiting[0]
    if (!found) return fail('no-waiting-node', 'no graph node is waiting for this pane')
    const node = found.run.state.graph.nodes.find((n) => n.id === found.node)
    if (!node?.result) return fail('no-result', `${found.node} takes no result`)
    const errors = resultErrors(node.result, raw)
    await found.run.recordReport(found.node, errors.length === 0)
    if (errors.length > 0) return fail('bad-result', errors.join('; '))
    const late = this.engine.waitingOn({ type: AGENT_LATE, pane }).length > 0
    if (late) {
      this.lateTimers.get(pane)?.()
      this.lateTimers.delete(pane)
      await this.engine.deliver({ type: AGENT_LATE, pane, result: raw as Output })
    } else {
      this.reports.set(pane, raw as Output)
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
