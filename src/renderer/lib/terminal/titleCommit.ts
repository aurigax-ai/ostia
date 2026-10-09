export const TITLE_COMMIT_MS = 1000

export interface TitleCommitter {
  push: (title: string) => void
  cancel: () => void
}

export function createTitleCommitter(
  commit: (title: string) => void,
  intervalMs: number = TITLE_COMMIT_MS,
): TitleCommitter {
  let committedAt = Number.NEGATIVE_INFINITY
  let pending: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const commitPending = (): void => {
    timer = null
    if (pending === null) return
    const title = pending
    pending = null
    committedAt = Date.now()
    commit(title)
  }

  const push = (title: string): void => {
    pending = title
    if (timer) return
    const wait = committedAt + intervalMs - Date.now()
    if (wait <= 0) commitPending()
    else timer = setTimeout(commitPending, wait)
  }

  const cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    pending = null
  }

  return { push, cancel }
}
