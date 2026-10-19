export interface BindFollower {
  start: () => void
  stop: () => void
}

interface BindFollowerOptions {
  everyMs: number
  resolve: () => string | null
  bound: () => string | null
  rebind: () => Promise<void>
}

export function createBindFollower({
  everyMs,
  resolve,
  bound,
  rebind,
}: BindFollowerOptions): BindFollower {
  let timer: ReturnType<typeof setInterval> | null = null
  let busy = false
  const tick = async (): Promise<void> => {
    if (busy || resolve() === bound()) return
    busy = true
    try {
      await rebind()
    } finally {
      busy = false
    }
  }
  return {
    start: () => {
      if (timer) return
      timer = setInterval(() => void tick(), everyMs)
      timer.unref()
    },
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
