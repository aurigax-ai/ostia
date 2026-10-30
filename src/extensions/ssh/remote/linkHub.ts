import type { HostLink } from './link'
import type { RemoteRegistry } from './registry'

export class LinkHub {
  private readonly links = new Map<string, HostLink>()

  constructor(
    private readonly registry: RemoteRegistry,
    private readonly make: (host: string) => HostLink | null,
  ) {}

  sync(): void {
    const wanted = new Set(this.registry.hosts())
    for (const [host, link] of this.links) {
      if (wanted.has(host)) continue
      link.stop()
      this.links.delete(host)
    }
    for (const host of wanted) {
      if (this.links.has(host)) continue
      const link = this.make(host)
      if (!link) continue
      this.links.set(host, link)
      link.start()
    }
  }

  stopAll(): void {
    for (const link of this.links.values()) link.stop()
    this.links.clear()
  }
}
