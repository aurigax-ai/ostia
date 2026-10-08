import { ARTIFACT_FILE_MAX_BYTES, type ArtifactEntry } from '@shared/artifacts'
import { useArtifactsStore } from '../stores/artifactsStore'
import { useLayoutStore } from '../stores/layoutStore'

const KIB = 1024
const MIB = KIB * KIB

export function sizeText(bytes: number): string {
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`
  if (bytes >= KIB) return `${Math.round(bytes / KIB)} KiB`
  return `${bytes} B`
}

export function opensInOstia(entry: Pick<ArtifactEntry, 'size'>): boolean {
  return entry.size <= ARTIFACT_FILE_MAX_BYTES
}

export function openArtifact(workspaceId: string, entry: ArtifactEntry): void {
  useArtifactsStore.getState().markRead(entry.path)
  if (opensInOstia(entry)) useLayoutStore.getState().openFile(workspaceId, entry.path)
  else window.ostia.artifacts.reveal(workspaceId)
}
