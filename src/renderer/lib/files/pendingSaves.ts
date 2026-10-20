const SAVE_WAIT_MS = 10_000

const pending = new Map<string, Set<Promise<unknown>>>()

export function trackSave<T>(filePath: string, save: Promise<T>): Promise<T> {
  const set = pending.get(filePath) ?? new Set()
  pending.set(filePath, set)
  const entry = save.then(
    () => undefined,
    () => undefined,
  )
  set.add(entry)
  void entry.then(() => {
    set.delete(entry)
    if (set.size === 0 && pending.get(filePath) === set) pending.delete(filePath)
  })
  return save
}

export async function settleSaves(
  filePaths: readonly string[],
  timeoutMs = SAVE_WAIT_MS,
): Promise<void> {
  const waits = filePaths.flatMap((path) => [...(pending.get(path) ?? [])])
  if (waits.length === 0 || timeoutMs <= 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  await Promise.race([Promise.all(waits), limit])
  clearTimeout(timer)
}
