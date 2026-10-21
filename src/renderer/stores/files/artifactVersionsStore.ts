import type { ArtifactVersion, ArtifactVersionContent } from '@shared/artifacts/artifacts'
import { create } from 'zustand'
import { useArtifactsStore } from '@/stores/files/artifactsStore'

export interface ShownVersion {
  workspaceId: string
  path: string
  version: ArtifactVersion
  content: ArtifactVersionContent
  modifiedAtOpen: number | null
}

interface ArtifactVersionsState {
  byPane: Record<string, ShownVersion>
  show: (
    workspaceId: string,
    paneId: string,
    path: string,
    version: ArtifactVersion,
  ) => Promise<void>
  back: (paneId: string) => void
}

function modifiedOf(workspaceId: string, path: string): number | null {
  const entries = useArtifactsStore.getState().byWorkspace[workspaceId]?.entries ?? []
  return entries.find((entry) => entry.path === path)?.modified ?? null
}

export const useArtifactVersionsStore = create<ArtifactVersionsState>((set) => ({
  byPane: {},

  show: async (workspaceId, paneId, path, version) => {
    const content = await window.ostia.artifacts.version(workspaceId, path, version.id)
    if (!content) return
    const shown = {
      workspaceId,
      path,
      version,
      content,
      modifiedAtOpen: modifiedOf(workspaceId, path),
    }
    set((s) => ({ byPane: { ...s.byPane, [paneId]: shown } }))
  },

  back: (paneId) =>
    set((s) => {
      if (!s.byPane[paneId]) return s
      const { [paneId]: _gone, ...byPane } = s.byPane
      return { byPane }
    }),
}))
