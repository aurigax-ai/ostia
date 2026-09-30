import { debounce } from 'es-toolkit'
import { type RestorableWorkspace, buildSnapshot } from '../layout/snapshot'
import { allPanes } from '../layout/tree'
import { runningAgentOf } from '../lib/paneAgent'
import { useBlocksStore } from './blocksStore'
import { useLayoutStore } from './layoutStore'
import { useSettingsStore } from './settingsStore'
import { type Workspace, useWorkspacesStore } from './workspacesStore'

export function isRestorable(workspace: Workspace): workspace is Workspace & RestorableWorkspace {
  return workspace.kind !== 'manager'
}

const SAVE_DEBOUNCE_MS = 400

const scheduleSave = debounce(saveSnapshotNow, SAVE_DEBOUNCE_MS)
let clearedForDisabled = false
let frozen = false

export function liveAgentPanes(): Set<string> {
  const live = new Set<string>()
  for (const layout of Object.values(useLayoutStore.getState().byWorkspace)) {
    for (const pane of layout ? allPanes(layout.root) : []) {
      if (pane.resume && runningAgentOf(pane.id) === pane.resume.agent) live.add(pane.id)
    }
  }
  return live
}

export function freezeSnapshots(): void {
  saveSnapshotNow()
  frozen = true
}

export function saveSnapshotNow(): void {
  scheduleSave.cancel()
  const api = window.pine?.workspace
  if (!api || frozen) return

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
      workspaces: workspaces.filter(isRestorable),
      groups,
      activeWorkspaceId,
      layouts: useLayoutStore.getState().byWorkspace,
      savedAt: new Date().toISOString(),
      liveAgentPanes: liveAgentPanes(),
    }),
  )
}

export function startSnapshotAutosave(): () => void {
  saveSnapshotNow()

  const unsubscribe = [
    useWorkspacesStore.subscribe(() => scheduleSave()),
    useLayoutStore.subscribe(() => scheduleSave()),
    useSettingsStore.subscribe(() => scheduleSave()),
    useBlocksStore.subscribe((s, prev) => {
      if (s.running !== prev.running) scheduleSave()
    }),
  ]
  const onUnload = (): void => saveSnapshotNow()
  window.addEventListener('beforeunload', onUnload)

  return () => {
    for (const off of unsubscribe) off()
    window.removeEventListener('beforeunload', onUnload)
    scheduleSave.cancel()
  }
}
