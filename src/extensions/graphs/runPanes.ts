import type { FileJournalStore, GraphRun, MemoryJournalStore, Output } from '@aurigax-ai/graph'

export class RunPanes {
  private readonly panes = new Map<string, Set<string>>()
  private readonly rebuilt = new Set<string>()

  has(workspaceId: string, graph: string, pane: string): boolean {
    return this.panes.get(`${workspaceId}/${graph}`)?.has(pane) === true
  }

  noteRun(run: GraphRun): void {
    const key = `${run.state.scope}/${run.state.graphName}`
    for (const record of [...run.state.active.values(), ...run.state.history.values()]) {
      const pane = record.started?.pane
      if (typeof pane === 'string') this.note(key, pane)
    }
  }

  rebuild(store: FileJournalStore | MemoryJournalStore, workspaceId: string): void {
    if (this.rebuilt.has(workspaceId)) return
    this.rebuilt.add(workspaceId)
    for (const key of store.list(workspaceId)) {
      for (const line of store.read(key)?.lines ?? []) {
        const pane = (line as { started?: Output }).started?.pane
        if (typeof pane === 'string') this.note(`${workspaceId}/${key.graph}`, pane)
      }
    }
  }

  private note(key: string, pane: string): void {
    const panes = this.panes.get(key) ?? new Set<string>()
    panes.add(pane)
    this.panes.set(key, panes)
  }
}
