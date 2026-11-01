import {
  type RemoteFolder,
  remotePath,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { ArrowClockwiseIcon, CaretRightIcon, XIcon } from '@phosphor-icons/react'
import { type JSX, useState } from 'react'
import { Hint } from '@/components/common/Hint'
import { IconButton } from '@/components/common/IconButton'
import { Badge } from '@/components/ui/badge'
import { fmt, useDict } from '@/lib/app/useDict'
import { FileTree } from './FileTree'
import { type TreeFocus, useTreeContext } from './fileTreeContext'
import { useFolderDrop } from './fileTreeRows'

export function RemoteFolderSection({
  folder,
  focus,
}: {
  folder: RemoteFolder
  focus: TreeFocus
}): JSX.Element {
  const d = useDict()
  const [open, setOpen] = useState(true)
  const [generation, setGeneration] = useState(0)
  const root = remotePath(folder.id, folder.root)
  const tree = useTreeContext(focus, root)
  const { over: _over, ...refusedDrop } = useFolderDrop(root, tree)
  return (
    <section className="remote-folder" data-testid="remote-folder" data-host={folder.host}>
      <div className="remote-folder-head">
        <button
          type="button"
          className="remote-folder-toggle"
          aria-expanded={open}
          aria-label={fmt(d.remoteFolders.collapse, { host: folder.host })}
          onClick={() => setOpen((o) => !o)}
        >
          <CaretRightIcon size={16} className={`file-twisty${open ? ' open' : ''}`} />
          <Badge variant="outline" className="remote-folder-badge">
            {d.remoteFolders.badge}
          </Badge>
          <span className="remote-folder-host">{folder.host}</span>
        </button>
        <IconButton
          icon={ArrowClockwiseIcon}
          label={d.remoteFolders.refresh}
          onClick={() => setGeneration((g) => g + 1)}
        />
        <IconButton
          icon={XIcon}
          label={d.remoteFolders.close}
          onClick={() => void window.ostia.remoteFiles.close(folder.id)}
        />
      </div>
      <Hint label={`${folder.host}:${folder.root}`} side="bottom">
        <div className="remote-folder-path">{folder.root}</div>
      </Hint>
      {open ? (
        <div className="file-tree remote-folder-tree" {...refusedDrop}>
          <FileTree key={`${root}#${generation}`} path={root} depth={0} tree={tree} />
        </div>
      ) : null}
    </section>
  )
}
