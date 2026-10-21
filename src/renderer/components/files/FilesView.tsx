import {
  EyeIcon,
  FilePlusIcon,
  FolderPlusIcon,
  MagnifyingGlassIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useRef } from 'react'
import { Hint, useShortcutHint } from '@/components/common/Hint'
import { IconButton } from '@/components/common/IconButton'
import { useDict } from '@/lib/app/useDict'
import { isUnderExcluded } from '@/lib/files/fileTree'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useFileTreeStore } from '@/stores/files/fileTreeStore'
import { useRemoteFoldersStore } from '@/stores/files/remoteFoldersStore'
import { ArtifactsSection } from './ArtifactsSection'
import { FilesCrumb } from './FilesCrumb'
import { FilesSearch } from './FilesSearch'
import { FilesViewOptions } from './FilesViewOptions'
import { FileTree } from './FileTree'
import { FileTrashDialog } from './FileTreeOps'
import { useTreeContext, useTreeFocus } from './fileTreeContext'
import { useFolderDrop } from './fileTreeRows'
import { RemoteFolderSection } from './RemoteFolderSection'

export function FilesView(): JSX.Element {
  const d = useDict()
  const focus = useTreeFocus()
  const { workspaceId, cwd, activeFile } = focus
  const revealed = useFileTreeStore((s) => s.revealed)
  const reveal = revealed?.root === cwd ? revealed.path : null
  const stableFocus = useMemo(
    () => ({ workspaceId, cwd, activeFile, reveal }),
    [workspaceId, cwd, activeFile, reveal],
  )
  const tree = useTreeContext(stableFocus)
  const { over: rootOver, ...rootDrop } = useFolderDrop(cwd, tree)
  const allFolders = useRemoteFoldersStore((s) => s.folders)
  const folders = useMemo(
    () => allFolders.filter((folder) => folder.workspaceId === workspaceId),
    [allFolders, workspaceId],
  )
  const searchOpen = useUIStore((s) => s.filesSearchOpen)
  const searchButton = useRef<HTMLButtonElement>(null)
  const searchWasOpen = useRef(searchOpen)
  useEffect(() => {
    const hidden = searchWasOpen.current && !searchOpen
    searchWasOpen.current = searchOpen
    const focused = document.activeElement
    if (hidden && (!focused || focused === document.body)) searchButton.current?.focus()
  }, [searchOpen])
  const searchChord = useShortcutHint('view.searchFiles') ? 'view.searchFiles' : 'find'

  const local = (
    <>
      <Hint label={cwd} side="bottom">
        <div className="files-crumb">
          <FilesCrumb path={cwd} />
        </div>
      </Hint>
      <FilesSearch
        root={cwd}
        isHidden={(path) =>
          !tree.settings.showExcluded && isUnderExcluded(tree.isExcluded, path, cwd)
        }
        onReveal={(path) => useFileTreeStore.getState().reveal(cwd, path)}
      >
        <div className={`file-tree${rootOver ? ' drop-target' : ''}`} {...rootDrop}>
          <FileTree key={cwd} path={cwd} depth={0} tree={tree} />
        </div>
      </FilesSearch>
    </>
  )

  return (
    <>
      <div className="rail-section files-head">
        <span className="files-title">{d.rail.files}</span>
        <div className="files-toolbar">
          <IconButton
            ref={searchButton}
            icon={MagnifyingGlassIcon}
            label={d.filesView.showSearch}
            command={searchChord}
            aria-pressed={searchOpen}
            onClick={() => {
              const ui = useUIStore.getState()
              if (searchOpen) ui.hideFilesSearch()
              else ui.searchFiles()
            }}
          />
          <IconButton
            icon={FilePlusIcon}
            label={d.filesView.ops.newFile}
            onClick={() =>
              useFileTreeStore.getState().setEdit({ kind: 'create', entry: 'file', dir: cwd })
            }
          />
          <IconButton
            icon={FolderPlusIcon}
            label={d.filesView.ops.newFolder}
            onClick={() =>
              useFileTreeStore.getState().setEdit({ kind: 'create', entry: 'folder', dir: cwd })
            }
          />
          <IconButton
            icon={EyeIcon}
            label={d.filesView.showExcluded}
            aria-pressed={tree.settings.showExcluded}
            onClick={() =>
              useSettingsStore.getState().setFiles({ showExcluded: !tree.settings.showExcluded })
            }
          />
          <FilesViewOptions settings={tree.settings} />
          <IconButton
            icon={XIcon}
            label={d.rail.closeFiles}
            onClick={() => useUIStore.getState().toggleFiles()}
          />
        </div>
      </div>
      {folders.length === 0 ? (
        local
      ) : (
        <div className="files-scroll">
          {folders.map((folder) => (
            <RemoteFolderSection key={folder.id} folder={folder} focus={stableFocus} />
          ))}
          <div className="rail-section files-local-head">{d.remoteFolders.local}</div>
          {local}
        </div>
      )}
      <ArtifactsSection workspaceId={workspaceId} />
      <FileTrashDialog workspaceId={workspaceId} />
    </>
  )
}
