import { Badge } from '@/components/ui/badge'
import { fmt, useDict } from '@/lib/app/useDict'
import { cn } from '@/lib/utils'
import { remoteFolderOf, useRemoteFoldersStore } from '@/stores/files/remoteFoldersStore'
import {
  type RemoteFileError,
  parseRemotePath,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { useContext } from 'react'
import { NoticeAppearing } from './noticeAppearing'

export function RemoteFileBar({
  filePath,
  problem,
}: {
  filePath: string
  problem: RemoteFileError | null
}): JSX.Element {
  const d = useDict()
  const appearing = useContext(NoticeAppearing)
  const folders = useRemoteFoldersStore((s) => s.folders)
  const parsed = parseRemotePath(filePath)
  const folder = parsed ? remoteFolderOf(folders, parsed.folderId) : null
  return (
    <output
      data-testid="remote-file-bar"
      className={cn(
        'language-notice flex items-center gap-2 border-line border-b bg-surface-2 px-3 text-fg-muted text-ui-sm',
        appearing && 'motion-fade',
      )}
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
