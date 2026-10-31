export class ShellStops {
  private readonly waiting = new Map<string, Set<string>>()

  constructor(private readonly stopJob: (host: string, pane: string) => Promise<void>) {}

  async stop(host: string, pane: string): Promise<void> {
    try {
      await this.stopJob(host, pane)
      this.waiting.get(host)?.delete(pane)
    } catch {
      const panes = this.waiting.get(host) ?? new Set<string>()
      panes.add(pane)
      this.waiting.set(host, panes)
    }
  }

  async retry(host: string): Promise<void> {
    await Promise.all([...(this.waiting.get(host) ?? [])].map((pane) => this.stop(host, pane)))
  }
}
