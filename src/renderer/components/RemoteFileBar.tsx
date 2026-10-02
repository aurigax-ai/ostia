import { type RemoteFileError, parseRemotePath } from '@shared/remoteFolders'
import { fmt, useDict } from '../i18n/useDict'
import { remoteFolderOf, useRemoteFoldersStore } from '../stores/remoteFoldersStore'
import { Badge } from './ui/badge'

export function RemoteFileBar({
  filePath,
  problem,
}: {
  filePath: string
  problem: RemoteFileError | null
}): JSX.Element {
  const d = useDict()
  const folders = useRemoteFoldersStore((s) => s.folders)
  const parsed = parseRemotePath(filePath)
  const folder = parsed ? remoteFolderOf(folders, parsed.folderId) : null
  return (
    <output
      data-testid="remote-file-bar"
      className="language-notice flex items-center gap-2 border-line border-b bg-surface-2 px-3 text-fg-muted text-ui-sm"
    >
      <Badge variant="outline">{d.remoteFolders.badge}</Badge>
      <span className="truncate">
        {folder ? fmt(d.remoteFolders.onHost, { host: folder.host }) : d.remoteFolders.closed}
      </span>
      {folder && problem ? (
        <span className="truncate text-fg" role="alert">
          {d.remoteFolders.errors[problem]}
        </span>
      ) : null}
    </output>
  )
}
