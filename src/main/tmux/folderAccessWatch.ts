import { FolderAccessMonitor, type FolderReads, type ProtectedFolder } from './folderAccess'

export const FOCUS_PROBE_MIN_MS = 60_000
export const PERIODIC_PROBE_MS = 5 * 60_000

export interface FolderAccessWatchDeps {
  now: () => number
  hasFullDiskAccess: () => Promise<boolean>
  readMain: () => Promise<FolderReads>
  readKept: () => Promise<FolderReads | null>
  announce: (folders: ProtectedFolder[]) => void
}

export interface FolderAccessWatch {
  probe: () => Promise<void>
  focused: () => Promise<void>
}

export function createFolderAccessWatch(deps: FolderAccessWatchDeps): FolderAccessWatch {
  const monitor = new FolderAccessMonitor()
  let running: Promise<void> | null = null
  let lastStart: number | null = null

  async function round(): Promise<void> {
    if (!(await deps.hasFullDiskAccess())) return
    const reads = [await deps.readMain()]
    const kept = await deps.readKept()
    if (kept) reads.push(kept)
    const blocked = monitor.observe(reads)
    if (blocked) deps.announce(blocked)
  }

  function probe(): Promise<void> {
    if (running) return running
    lastStart = deps.now()
    running = round()
      .catch(() => undefined)
      .finally(() => {
        running = null
      })
    return running
  }

  function focused(): Promise<void> {
    if (running) return running
    if (lastStart !== null && deps.now() - lastStart < FOCUS_PROBE_MIN_MS) {
      return Promise.resolve()
    }
    return probe()
  }

  return { probe, focused }
}
