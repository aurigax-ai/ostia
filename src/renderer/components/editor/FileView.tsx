import { fileViewKind } from '@/lib/files/fileKinds'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import { useArtifactVersionsStore } from '@/stores/files/artifactVersionsStore'
import { isRemotePath } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
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
  const viewerOnly = Boolean(filePath && (versioned || kind === 'image' || kind === 'pdf'))
  useSurfaceFocus(viewerOnly ? paneId : undefined, null)
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
