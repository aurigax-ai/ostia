import {
  END,
  type GraphFile,
  type Problem,
  type RunSummary,
  type RunView,
  descriptorOf,
  isConditional,
  isJoin,
  neededConnectors,
  neededKinds,
  startNodes,
  triggerKind,
} from '@aurigax-ai/graph'
import { graphsFolder } from './graphFiles'
import type { GraphListing, GraphState } from './runner'

export interface GraphRow {
  name: string
  description?: string
  state: GraphState
  problem?: Problem
  triggers: string[]
  agentsMayStart: boolean
  lastRun?: { runId: string; status: string; startedAt: number }
  fingerprint?: string
}

interface NodeDefinition {
  id: string
  kind: string
  effect: string
  title?: string
  fields: Record<string, unknown>
  result?: Record<string, unknown>
  once: boolean
  timeout?: string
  out?: Record<string, string>
}

export interface Definition {
  name: string
  fingerprint: string
  description?: string
  triggers: { kind: string; detail: Record<string, unknown> }[]
  agentsMayStart: boolean
  start: string[]
  nodes: NodeDefinition[]
  edges: {
    from: string
    to: string
    condition?: string
    kind: 'plain' | 'fan-out' | 'join' | 'when' | 'else'
  }[]
  state: Record<string, unknown>
  limits: Record<string, unknown>
  kinds: string[]
  connectors: string[]
  problems: Problem[]
}

export interface ListModel {
  workspaceId: string
  folder: string
  scratch: boolean
  graphs: GraphRow[]
}

function agentsMayStart(graph: GraphFile): boolean {
  return graph.on.some(
    (t) =>
      triggerKind(t) === 'manual' && (t as { manual: { agents?: boolean } }).manual.agents === true,
  )
}

export function listModel(
  workspaceId: string,
  workDir: string,
  listings: GraphListing[],
  runs: RunSummary[],
): ListModel {
  return {
    workspaceId,
    folder: graphsFolder(workDir),
    scratch: false,
    graphs: listings.map((l) => {
      const graph = l.entry.loaded?.graph
      const last = runs.find((r) => r.graph === l.entry.name)
      return {
        name: l.entry.name,
        state: l.state,
        triggers: graph ? graph.on.map(triggerKind) : [],
        agentsMayStart: graph ? agentsMayStart(graph) : false,
        ...(graph?.description ? { description: graph.description } : {}),
        ...(l.problems[0] ? { problem: l.problems[0] } : {}),
        ...(last
          ? { lastRun: { runId: last.runId, status: last.status, startedAt: last.startedAt } }
          : {}),
        ...(l.entry.loaded ? { fingerprint: l.entry.loaded.fingerprint } : {}),
      }
    }),
  }
}

function edges(graph: GraphFile): Definition['edges'] {
  const out: Definition['edges'] = []
  for (const edge of graph.edges) {
    if (isJoin(edge)) for (const from of edge.from) out.push({ from, to: edge.to, kind: 'join' })
    else if (isConditional(edge)) {
      for (const branch of edge.when)
        out.push({ from: edge.from, to: branch.to, condition: branch.if, kind: 'when' })
      out.push({ from: edge.from, to: edge.else, kind: 'else' })
    } else if (Array.isArray(edge.to))
      for (const to of edge.to) out.push({ from: edge.from, to, kind: 'fan-out' })
    else out.push({ from: edge.from, to: edge.to === END ? END : edge.to, kind: 'plain' })
  }
  return out
}

export function definition(listing: GraphListing): Definition | null {
  const loaded = listing.entry.loaded
  if (!loaded) return null
  const graph = loaded.graph
  return {
    name: loaded.name,
    fingerprint: loaded.fingerprint,
    ...(graph.description ? { description: graph.description } : {}),
    triggers: graph.on.map((t) => ({
      kind: triggerKind(t),
      detail: (t as unknown as Record<string, Record<string, unknown>>)[triggerKind(t)] ?? {},
    })),
    agentsMayStart: agentsMayStart(graph),
    start: startNodes(graph),
    nodes: graph.nodes.map((n) => {
      const descriptor = descriptorOf(n.kind)
      return {
        id: n.id,
        kind: n.kind,
        effect: descriptor?.effect ?? 'unknown',
        fields: n.with ?? {},
        once: n.once ?? descriptor?.once ?? false,
        ...(n.title ? { title: n.title } : {}),
        ...(n.result ? { result: n.result } : {}),
        ...(n.timeout ? { timeout: n.timeout } : {}),
        ...(n.out ? { out: n.out } : {}),
      }
    }),
    edges: edges(graph),
    state: graph.state,
    limits: { ...graph.limits },
    kinds: neededKinds(graph),
    connectors: neededConnectors(graph),
    problems: listing.problems,
  }
}

export interface RunModel extends RunView {
  graph: string
}

export function runModel(view: RunView, openPanes: ReadonlySet<string>): RunModel {
  return {
    ...view,
    graph: view.summary.graph,
    nodes: view.nodes.map((n) => {
      const pane =
        typeof n.started?.pane === 'string'
          ? n.started.pane
          : typeof n.output?.pane === 'string'
            ? n.output.pane
            : null
      return pane && openPanes.has(pane) ? { ...n, pane } : n
    }),
  }
}
