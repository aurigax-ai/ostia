export interface Limiter {
  take: () => boolean
}

const MINUTE_MS = 60_000

export function createLimiter(perMinute: number, now: () => number = Date.now): Limiter {
  const capacity = Math.max(1, perMinute)
  let tokens = capacity
  let last = now()
  return {
    take: () => {
      const at = now()
      tokens = Math.min(capacity, tokens + ((at - last) * capacity) / MINUTE_MS)
      last = at
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}
