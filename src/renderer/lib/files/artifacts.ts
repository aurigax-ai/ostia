import {
  ARTIFACT_FILE_MAX_BYTES,
  type ArtifactEntry,
  type ArtifactListing,
} from '@shared/artifacts/artifacts'
import { useEffect } from 'react'
import { useArtifactsStore } from '@/stores/files/artifactsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

export function opensInOstia(entry: Pick<ArtifactEntry, 'size'>): boolean {
  return entry.size <= ARTIFACT_FILE_MAX_BYTES
}

export function openArtifact(workspaceId: string, entry: ArtifactEntry): void {
  useArtifactsStore.getState().markRead(entry.path)
  if (opensInOstia(entry)) useLayoutStore.getState().openFile(workspaceId, entry.path)
  else window.ostia.artifacts.reveal(workspaceId)
}

export async function openPad(workspaceId: string): Promise<boolean> {
  const pad = await window.ostia.artifacts.pad(workspaceId)
  if (!pad) return false
  useArtifactsStore.getState().markRead(pad)
  useLayoutStore.getState().openFile(workspaceId, pad)
  return true
}

export function useArtifactListing(workspaceId: string): ArtifactListing | undefined {
  const listing = useArtifactsStore((s) => s.byWorkspace[workspaceId])
  useEffect(() => {
    if (!useArtifactsStore.getState().byWorkspace[workspaceId]) {
      void useArtifactsStore.getState().refresh(workspaceId)
    }
  }, [workspaceId])
  return listing
}
