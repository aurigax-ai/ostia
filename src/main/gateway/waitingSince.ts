export interface WaitingSinceDeps {
  now: () => number
  workspaceOf: (paneId: string) => string | undefined
}

export class WaitingSince {
  private readonly since = new Map<string, number>()

  constructor(private readonly deps: WaitingSinceDeps) {}

  change(paneId: string, state: string | undefined): void {
    if (state !== 'waiting') {
      this.since.delete(paneId)
      return
    }
    if (!this.since.has(paneId)) this.since.set(paneId, this.deps.now())
  }

  forget(paneId: string): void {
    this.since.delete(paneId)
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
