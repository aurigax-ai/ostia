import { buildSnapshot } from '../layout/snapshot'
import { useLayoutStore } from './layoutStore'
import { useSessionsStore } from './sessionsStore'
import { useSettingsStore } from './settingsStore'

/**
 * Workspace autosave — the renderer half of session restore (`main/sessionSnapshot.ts` owns
 * the durable half, `layout/snapshot.ts` the translation).
 *
 * The renderer owns the layout tree, so main can't reconstruct the workspace on its own and
 * quit is far too late to ask for it. Instead the snapshot is kept continuously fresh: every
 * session/layout edit schedules a debounced write, so by the time `before-quit` fires main
 * already has an up-to-date file on disk and only needs to add the pty scrollback.
 */

/** Long enough to collapse a drag-resize or a burst of splits; short enough to survive a crash. */
const SAVE_DEBOUNCE_MS = 400

let timer: ReturnType<typeof setTimeout> | null = null
/** Whether main has already been told "restore is off" — so we clear once, not on every edit. */
let clearedForDisabled = false

/**
 * Build and push the snapshot immediately, cancelling any pending debounce. With restore
 * switched off this instead tells main to forget what it has (once), which is what makes the
 * setting erase history rather than merely stop updating it.
 */
export function saveWorkspaceNow(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const api = window.pine?.session
  if (!api) return

  if (!useSettingsStore.getState().behavior.restoreSession) {
    if (!clearedForDisabled) {
      api.save(null)
      clearedForDisabled = true
    }
    return
  }
  clearedForDisabled = false

  const { sessions, activeSessionId } = useSessionsStore.getState()
  const snapshot = buildSnapshot({
    sessions,
    activeSessionId,
    layouts: useLayoutStore.getState().bySession,
    savedAt: new Date().toISOString(),
  })
  if (snapshot) api.save(snapshot)
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(saveWorkspaceNow, SAVE_DEBOUNCE_MS)
}

/**
 * Watch the stores that make up the workspace and keep the snapshot current. Returns a
 * dispose function (tests; the app runs this for the window's lifetime).
 *
 * `settingsStore` is in the watch set so flipping `restoreSession` takes effect at once —
 * off erases immediately, on re-captures immediately — instead of waiting for the next
 * unrelated layout edit.
 */
export function startWorkspaceAutosave(): () => void {
  // Write once up front so the snapshot and main's quit-time scrollback dump always describe
  // the same workspace, even if the user quits without touching anything.
  saveWorkspaceNow()

  const unsubscribe = [
    useSessionsStore.subscribe(schedule),
    useLayoutStore.subscribe(schedule),
    useSettingsStore.subscribe(schedule),
  ]
  // The debounced tail is the save that matters most — it holds the final layout the user
  // saw. `beforeunload` is the last point the renderer can still reach main.
  const onUnload = (): void => saveWorkspaceNow()
  window.addEventListener('beforeunload', onUnload)

  return () => {
    for (const off of unsubscribe) off()
    window.removeEventListener('beforeunload', onUnload)
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}
