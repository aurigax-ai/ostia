export const PUSH_WINDOW_MS = 250

export interface PushClock {
  now: () => number
  after: (ms: number, run: () => void) => void
}

export function coalesced(push: () => void, windowMs: number, clock: PushClock): () => void {
  let last = Number.NEGATIVE_INFINITY
  let pending = false
  const fire = (): void => {
    pending = false
    last = clock.now()
    push()
  }
  return () => {
    if (pending) return
    const wait = last + windowMs - clock.now()
    if (wait <= 0) {
      fire()
      return
    }
    pending = true
    clock.after(wait, fire)
  }
}
