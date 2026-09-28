import { buildSnapshot } from '../layout/snapshot'
import { useLayoutStore } from './layoutStore'
import { useSessionsStore } from './sessionsStore'
import { useSettingsStore } from './settingsStore'

const SAVE_DEBOUNCE_MS = 400

let timer: ReturnType<typeof setTimeout> | null = null
let clearedForDisabled = false

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

export function startWorkspaceAutosave(): () => void {
  saveWorkspaceNow()

  const unsubscribe = [
    useSessionsStore.subscribe(schedule),
    useLayoutStore.subscribe(schedule),
    useSettingsStore.subscribe(schedule),
  ]
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
