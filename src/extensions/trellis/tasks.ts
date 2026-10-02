export interface AgentTask {
  ref: string
  paneId: string
  agent: string | null
  at: number
}

export class AgentTasks {
  private readonly byRef = new Map<string, AgentTask>()

  set(task: AgentTask): void {
    this.byRef.set(task.ref, task)
  }

  get(ref: string): AgentTask | undefined {
    return this.byRef.get(ref)
  }

  dropPane(paneId: string): boolean {
    let dropped = false
    for (const [ref, task] of this.byRef) {
      if (task.paneId !== paneId) continue
      this.byRef.delete(ref)
      dropped = true
    }
    return dropped
  }

  list(): AgentTask[] {
    return [...this.byRef.values()]
  }
}
