import type { HostForwards } from './forwards'
import type { HostLink } from './link'
import type { RemoteRegistry } from './registry'

export interface HostParts {
  link: HostLink
  forwards: HostForwards
}

export class LinkHub {
  private readonly parts = new Map<string, HostParts>()

  constructor(
    private readonly registry: RemoteRegistry,
    private readonly make: (host: string) => HostParts | null,
  ) {}

  forwards(host: string): HostForwards | undefined {
    return this.parts.get(host)?.forwards
  }

  sync(): void {
    const wanted = new Set(this.registry.hosts())
    for (const [host, parts] of this.parts) {
      if (wanted.has(host)) continue
      this.stopParts(parts)
      this.parts.delete(host)
    }
    for (const host of wanted) {
      if (this.parts.has(host)) continue
      const parts = this.make(host)
      if (!parts) continue
      this.parts.set(host, parts)
      parts.link.start()
    }
  }

  stopAll(): void {
    for (const parts of this.parts.values()) this.stopParts(parts)
    this.parts.clear()
  }

  private stopParts(parts: HostParts): void {
    parts.link.stop()
    parts.forwards.closeAll()
  }
}
