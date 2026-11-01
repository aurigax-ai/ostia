import {
  parseRemotePath,
  type RemoteFileError,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import type { JSX } from 'react'
import { StatusLine } from '@/components/common/StatusLine'
import { Badge } from '@/components/ui/badge'
import { fmt, useDict } from '@/lib/app/useDict'
import { remoteFolderOf, useRemoteFoldersStore } from '@/stores/files/remoteFoldersStore'

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
  const failed = folder && problem ? d.remoteFolders.errors[problem] : null
  return (
    <StatusLine data-testid="remote-file-bar" tone={failed ? 'warn' : 'muted'}>
      <Badge variant="outline" className="mr-2">
        {d.remoteFolders.badge}
      </Badge>
      {folder ? fmt(d.remoteFolders.onHost, { host: folder.host }) : d.remoteFolders.closed}
      {failed ? <span role="alert"> {failed}</span> : null}
    </StatusLine>
  )
}
