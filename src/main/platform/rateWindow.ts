export class RateWindow {
  private readonly stamps: number[] = []

  constructor(private readonly windowMs: number) {}

  take(limit: number, now: number): boolean {
    while (this.stamps.length > 0 && now - (this.stamps[0] ?? 0) >= this.windowMs) {
      this.stamps.shift()
    }
    if (this.stamps.length >= limit) return false
    this.stamps.push(now)
    return true
  }
}
