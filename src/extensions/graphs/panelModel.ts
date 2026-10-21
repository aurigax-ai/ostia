import {
  connectorUses,
  descriptorOf,
  END,
  type GraphFile,
  isConditional,
  isJoin,
  neededConnectors,
  neededKinds,
  type Problem,
  type RunSummary,
  type RunView,
  startNodes,
  triggerKind,
} from '@aurigax-ai/wire'
import { NATIVE_CONNECTORS } from './connectorHost'
import { GRAPHS_FOLDER } from './graphFiles'
import type { GraphListing, GraphState } from './runner'
import type { LinkState } from './runtimeLink'

export interface GraphRow {
  name: string
  description?: string
  state: GraphState
  problem?: Problem
  triggers: string[]
  agentsMayStart: boolean
  lastRun?: { runId: string; status: string; startedAt: number }
  fingerprint?: string
  filesRefused?: boolean
  skipped?: number
}

interface ConnectorUseView {
  node: string
  use: string
  connection?: string
  effect: 'read' | 'write' | 'external'
  secretShaped: boolean
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
  connectorUses: ConnectorUseView[]
  problems: Problem[]
}

export interface ListModel {
  workspaceId: string
  folder: string
  scratch: boolean
  graphs: GraphRow[]
}

export type RuntimeModel =
  | { state: 'ready'; daemon: boolean; version: string }
  | { state: 'other-contract'; version?: string }
  | { state: 'connecting' }
  | { state: 'failed'; message: string }

export function runtimeModel(state: LinkState): RuntimeModel {
  if (state.kind === 'ready')
    return { state: 'ready', daemon: state.mode === 'daemon', version: state.version }
  if (state.kind === 'other-contract')
    return { state: 'other-contract', ...(state.version ? { version: state.version } : {}) }
  if (state.kind === 'failed') return { state: 'failed', message: state.message }
  return { state: 'connecting' }
}

function agentsMayStart(graph: GraphFile): boolean {
  return graph.on.some(
    (t) =>
      triggerKind(t) === 'manual' && (t as { manual: { agents?: boolean } }).manual.agents === true,
  )
}

export function listModel(
  workspaceId: string,
  listings: GraphListing[],
  runs: RunSummary[],
): ListModel {
  return {
    workspaceId,
    folder: GRAPHS_FOLDER,
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
        ...(l.filesRefused ? { filesRefused: true } : {}),
        ...(l.skipped > 0 ? { skipped: l.skipped } : {}),
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

export function definition(
  listing: GraphListing,
  secretShaped: ReadonlySet<string> = new Set(),
): Definition | null {
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
    connectorUses: connectorUses(graph, { native: NATIVE_CONNECTORS }).map((u) => ({
      node: u.node,
      use: u.use,
      effect: u.effect,
      secretShaped: secretShaped.has(u.node),
      ...(u.connection ? { connection: u.connection } : {}),
    })),
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
