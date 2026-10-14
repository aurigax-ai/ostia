export type Subscribe = (wake: () => void) => () => void

export type Settled<T> = { ok: true; value: T } | { ok: false; reason: string; value?: T }

type Observation<T> = Settled<T> | undefined

export function confirmed<T>(value: T): Settled<T> {
  return { ok: true, value }
}

export function mismatch<T>(reason: string, value?: T): Settled<T> {
  return value === undefined ? { ok: false, reason } : { ok: false, reason, value }
}

export class ChangeSignal {
  private readonly wakes = new Set<() => void>()

  readonly subscribe: Subscribe = (wake) => {
    this.wakes.add(wake)
    return () => {
      this.wakes.delete(wake)
    }
  }

  fire(): void {
    for (const wake of [...this.wakes]) wake()
  }
}

export function pollEvery(ms: number): Subscribe {
  return (wake) => {
    const timer = setInterval(wake, ms)
    return () => clearInterval(timer)
  }
}

export function anyOf(...subscriptions: Subscribe[]): Subscribe {
  return (wake) => {
    const offs = subscriptions.map((subscribe) => subscribe(wake))
    return () => {
      for (const off of offs) off()
    }
  }
}

export interface ConfirmSpec<T> {
  act: () => unknown
  observe: () => Observation<T> | Promise<Observation<T>>
  signal: Subscribe
  timeoutMs: number
  onTimeout: () => Settled<T> | Promise<Settled<T>>
}

export async function actThenConfirm<T>(spec: ConfirmSpec<T>): Promise<Settled<T>> {
  await spec.act()
  const first = await spec.observe()
  if (first) return first
  return new Promise((resolve) => {
    let checking = false
    let again = false
    let settled = false
    const finish = (result: Settled<T>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off()
      resolve(result)
    }
    const check = async (): Promise<void> => {
      if (settled) return
      if (checking) {
        again = true
        return
      }
      checking = true
      try {
        do {
          again = false
          const seen = await spec.observe()
          if (seen) return finish(seen)
        } while (again && !settled)
      } finally {
        checking = false
      }
    }
    const off = spec.signal(() => void check())
    const timer = setTimeout(async () => finish(await spec.onTimeout()), spec.timeoutMs)
    void check()
  })
}
