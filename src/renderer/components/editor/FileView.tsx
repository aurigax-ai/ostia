import { fileViewKind } from '@/lib/files/fileKinds'
import { useArtifactVersionsStore } from '@/stores/files/artifactVersionsStore'
import { isRemotePath } from '@shared/remoteFolders'
import { VersionView } from './ArtifactVersions'
import { EditorView } from './Editor'
import { ImageViewer } from './ImageViewer'
import { PdfViewer } from './PdfViewer'

export function FileView({
  workspaceId,
  paneId,
  filePath,
}: {
  workspaceId: string
  paneId: string
  filePath?: string
}): JSX.Element {
  const kind = isRemotePath(filePath) ? 'text' : fileViewKind(filePath)
  const versioned = useArtifactVersionsStore((s) =>
    Boolean(filePath && s.byPane[paneId]?.path === filePath),
  )
  if (filePath && versioned) {
    return <VersionView workspaceId={workspaceId} paneId={paneId} filePath={filePath} />
  }
  if (filePath && kind === 'image') {
    return (
      <ImageViewer key={filePath} workspaceId={workspaceId} paneId={paneId} filePath={filePath} />
    )
  }
  if (filePath && kind === 'pdf') {
    return (
      <PdfViewer key={filePath} workspaceId={workspaceId} paneId={paneId} filePath={filePath} />
    )
  }
  return <EditorView workspaceId={workspaceId} paneId={paneId} filePath={filePath} />
}
