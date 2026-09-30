import { buildSnapshot } from '../layout/snapshot'
import { useLayoutStore } from './layoutStore'
import { useSettingsStore } from './settingsStore'
import { useWorkspacesStore } from './workspacesStore'

const SAVE_DEBOUNCE_MS = 400

let timer: ReturnType<typeof setTimeout> | null = null
let clearedForDisabled = false

export function saveSnapshotNow(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const api = window.pine?.workspace
  if (!api) return

  if (!useSettingsStore.getState().behavior.restoreWorkspace) {
    if (!clearedForDisabled) {
      api.save(null)
      clearedForDisabled = true
    }
    return
  }
  clearedForDisabled = false

  const { workspaces, groups, activeWorkspaceId } = useWorkspacesStore.getState()
  api.save(
    buildSnapshot({
      workspaces,
      groups,
      activeWorkspaceId,
      layouts: useLayoutStore.getState().byWorkspace,
      savedAt: new Date().toISOString(),
    }),
  )
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(saveSnapshotNow, SAVE_DEBOUNCE_MS)
}

export function startSnapshotAutosave(): () => void {
  saveSnapshotNow()

  const unsubscribe = [
    useWorkspacesStore.subscribe(schedule),
    useLayoutStore.subscribe(schedule),
    useSettingsStore.subscribe(schedule),
  ]
  const onUnload = (): void => saveSnapshotNow()
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
