import { Badge } from '@/components/ui/badge'
import { fmt, useDict } from '@/lib/app/useDict'
import { remoteFolderOf, useRemoteFoldersStore } from '@/stores/files/remoteFoldersStore'
import {
  type RemoteFileError,
  parseRemotePath,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'

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
      className="language-notice motion-fade flex items-center gap-2 border-line border-b bg-surface-2 px-3 text-fg-muted text-ui-sm"
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
