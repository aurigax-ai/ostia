export type PaneChange =
  | { kind: 'attention'; attention: { state?: string } }
  | { kind: 'state' }
  | { kind: 'closed' }

export interface WaitingSinceDeps {
  now: () => number
  workspaceOf: (paneId: string) => string | undefined
}

export class WaitingSince {
  private readonly since = new Map<string, number>()

  constructor(private readonly deps: WaitingSinceDeps) {}

  observe(paneId: string, change: PaneChange): void {
    if (change.kind === 'closed') this.since.delete(paneId)
    else if (change.kind === 'attention') this.change(paneId, change.attention.state)
  }

  any(): boolean {
    return this.since.size > 0
  }

  private change(paneId: string, state: string | undefined): void {
    if (state !== 'waiting') {
      this.since.delete(paneId)
      return
    }
    if (!this.since.has(paneId)) this.since.set(paneId, this.deps.now())
  }

  ofPane(paneId: string): number | undefined {
    return this.since.get(paneId)
  }

  ofWorkspace(workspaceId: string): number | undefined {
    let newest: number | undefined
    for (const [paneId, at] of this.since) {
      if (this.deps.workspaceOf(paneId) === workspaceId && (newest === undefined || at > newest)) {
        newest = at
      }
    }
    return newest
  }
}
