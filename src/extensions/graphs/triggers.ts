import { join } from 'node:path'
import {
  type AgentState,
  type Clock,
  type GraphDefinition,
  type Output,
  PathBatch,
  type TriggerEvent,
  TriggerScheduler,
  firedBy,
} from '@aurigax-ai/graph'
import { scheduleMemory } from './enabled'
import { FolderWatcher, type WatchStart } from './folderWatch'

const SCHEDULES_FILE = 'schedules.json'

export interface EnabledGraph {
  workspaceId: string
  workDir: string
  name: string
  definition: GraphDefinition
}

export interface TriggerHostDeps {
  clock: Clock
  dataDir: string | null
  enabled: () => EnabledGraph[]
  fire: (graph: EnabledGraph, payload: Output) => void
  ownPane: (workspaceId: string, graph: string, pane: string) => boolean
  changed: () => void
  watcher?: (
    root: string,
    onPath: (rel: string) => void,
    onRefused: () => void,
  ) => {
    start: () => WatchStart
    stop: () => void
  }
}

interface Watched {
  root: string
  watcher: { start: () => WatchStart; stop: () => void }
  batch: PathBatch
}

export class TriggerHost {
  private readonly scheduler: TriggerScheduler
  private readonly watched = new Map<string, Watched>()
  private readonly refused = new Set<string>()
  private graphs: EnabledGraph[] = []

  constructor(private readonly deps: TriggerHostDeps) {
    this.scheduler = new TriggerScheduler({
      clock: deps.clock,
      memory: scheduleMemory(deps.dataDir ? join(deps.dataDir, SCHEDULES_FILE) : null),
      fire: (scheduled, payload) => {
        const graph = this.graphs.find((g) => keyOf(g) === scheduled.key)
        if (graph) deps.fire(graph, payload)
      },
    })
  }

  refresh(): void {
    this.graphs = this.deps.enabled()
    this.scheduler.set(this.graphs.map((g) => ({ key: keyOf(g), definition: g.definition })))
    const wantFiles = new Map<string, string>()
    for (const g of this.graphs) {
      if (g.definition.graph.on.some((t) => 'files' in t)) wantFiles.set(g.workspaceId, g.workDir)
    }
    for (const [workspaceId, watched] of this.watched) {
      if (wantFiles.get(workspaceId) !== watched.root) this.unwatch(workspaceId)
    }
    for (const workspaceId of [...this.refused]) {
      if (!wantFiles.has(workspaceId)) this.refused.delete(workspaceId)
    }
    for (const [workspaceId, root] of wantFiles) {
      if (!this.watched.has(workspaceId) && !this.refused.has(workspaceId))
        this.watch(workspaceId, root)
    }
  }

  filesRefused(workspaceId: string): boolean {
    return this.refused.has(workspaceId)
  }

  needsLiveHost(): boolean {
    return this.graphs.some((g) => g.definition.graph.on.some((t) => !('manual' in t)))
  }

  commandFinished(event: {
    paneId: string
    workspaceId: string
    exitCode?: number
    remote?: boolean
  }): void {
    if (event.remote === true || typeof event.exitCode !== 'number') return
    this.deliver(event.workspaceId, {
      kind: 'command',
      pane: event.paneId,
      exitCode: event.exitCode,
    })
  }

  agent(workspaceId: string, pane: string, state: AgentState, agent?: string): void {
    this.deliver(workspaceId, {
      kind: 'agent',
      pane,
      state,
      ...(agent !== undefined ? { agent } : {}),
    })
  }

  stop(): void {
    this.scheduler.stop()
    for (const workspaceId of [...this.watched.keys()]) this.unwatch(workspaceId)
  }

  private deliver(workspaceId: string, event: TriggerEvent): void {
    for (const graph of this.graphs) {
      if (graph.workspaceId !== workspaceId) continue
      if ('pane' in event && this.deps.ownPane(workspaceId, graph.name, event.pane)) continue
      const payload = firedBy(graph.definition.graph, event)
      if (payload) this.deps.fire(graph, payload)
    }
  }

  private watch(workspaceId: string, root: string): void {
    const batch = new PathBatch(this.deps.clock, (paths) =>
      this.deliver(workspaceId, { kind: 'files', paths }),
    )
    const make =
      this.deps.watcher ?? ((r, onPath, onRefused) => new FolderWatcher(r, onPath, onRefused))
    const watcher = make(
      root,
      (rel) => batch.add(rel),
      () => {
        this.unwatch(workspaceId)
        this.refused.add(workspaceId)
        this.deps.changed()
      },
    )
    const started = watcher.start()
    if (!started.ok) {
      batch.stop()
      this.refused.add(workspaceId)
      this.deps.changed()
      return
    }
    this.watched.set(workspaceId, { root, watcher, batch })
  }

  private unwatch(workspaceId: string): void {
    const watched = this.watched.get(workspaceId)
    watched?.watcher.stop()
    watched?.batch.stop()
    this.watched.delete(workspaceId)
  }
}

function keyOf(graph: EnabledGraph): string {
  return `${graph.workspaceId}/${graph.name}/${graph.definition.fingerprint}`
}
