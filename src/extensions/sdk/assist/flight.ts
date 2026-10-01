import { AssistFailure } from '..'

export interface Flight {
  run: <T>(signal: AbortSignal, task: () => Promise<T>) => Promise<T>
}

interface Waiter {
  go: () => void
  drop: () => void
}

export function createFlight(): Flight {
  let flying = false
  let next: Waiter | null = null

  const land = (): void => {
    flying = false
    const waiter = next
    next = null
    waiter?.go()
  }

  const run = <T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const cancelled = (): void => reject(new AssistFailure('cancelled'))
      const leave = (): void => {
        if (next === waiter) next = null
        cancelled()
      }
      const start = (): void => {
        signal.removeEventListener('abort', leave)
        if (signal.aborted) {
          cancelled()
          return
        }
        flying = true
        const work = Promise.resolve().then(task)
        work.then(land, land)
        signal.addEventListener('abort', cancelled, { once: true })
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled))
      }
      const waiter: Waiter = {
        go: start,
        drop: () => {
          signal.removeEventListener('abort', leave)
          cancelled()
        },
      }
      if (signal.aborted) {
        cancelled()
        return
      }
      if (!flying) {
        start()
        return
      }
      next?.drop()
      next = waiter
      signal.addEventListener('abort', leave, { once: true })
    })

  return { run }
}
