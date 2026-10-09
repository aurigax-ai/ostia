import { fileViewKind } from '@/lib/files/fileKinds'
import { isRemotePath } from '@shared/remoteFolders'
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
