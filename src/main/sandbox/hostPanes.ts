import { randomBytes } from 'node:crypto'

export interface HostPaneGrantsDeps {
  now: () => number
  ttlMs: number
}

export class HostPaneGrants {
  private readonly offers = new Map<string, number>()
  private readonly tokens = new Map<string, number>()

  constructor(private readonly deps: HostPaneGrantsDeps) {}

  offer(extId: string, command: string): void {
    this.offers.set(`${extId}\u0000${command}`, this.deps.now() + this.deps.ttlMs)
  }

  claim(extId: string, command: string): string | null {
    const key = `${extId}\u0000${command}`
    const expires = this.offers.get(key)
    this.offers.delete(key)
    if (expires === undefined || expires < this.deps.now()) return null
    const token = randomBytes(24).toString('hex')
    this.tokens.set(token, this.deps.now() + this.deps.ttlMs)
    return token
  }

  consume(token: string): boolean {
    const expires = this.tokens.get(token)
    this.tokens.delete(token)
    return expires !== undefined && expires >= this.deps.now()
  }
}
