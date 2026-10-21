import type { RemoteFileError } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { CaretRightIcon, LockSimpleIcon } from '@phosphor-icons/react'
import { archiveRoot, isArchivePath } from '@shared/archives/archivePaths'
import type { FsEntry } from '@shared/files/filesApi'
import { useEffect, useRef, useState } from 'react'
import { EmptyState } from '@/components/common/EmptyState'
import { useDict } from '@/lib/app/useDict'
import { themeIconSrc } from '@/lib/extensions/iconTheme'
import { type CompactChain, childPath, compactChain } from '@/lib/files/fileTree'
import { openFileInWorkspace } from '@/lib/files/openFile'
import { useFileTreeStore } from '@/stores/files/fileTreeStore'
import { FileMenu } from './FileMenu'
import { NameInputRow, treeRowKey } from './FileTreeOps'
import { fileIcon } from './fileIcon'
import { type ListFiles, listingError, type TreeContext } from './fileTreeContext'
import {
  expandKey,
  isTwisty,
  rowClass,
  startPathDrag,
  useFolderDrop,
  useRowEdit,
  visibilityOf,
} from './fileTreeRows'

type DirListing = { entries: FsEntry[] } | { error: RemoteFileError }

function useListing(path: string, list: ListFiles): DirListing | null {
  const [listing, setListing] = useState<DirListing | null>(null)
  const version = useFileTreeStore((s) => (s.versions[path] ?? 0) + s.epoch)
  useEffect(() => {
    void version
    let alive = true
    list(path).then(
      (entries) => {
        if (alive) setListing({ entries })
      },
      (err: unknown) => {
        if (alive) setListing({ error: listingError(err) })
      },
    )
    return () => {
      alive = false
    }
  }, [path, list, version])
  return listing
}

function ListingError({ error, depth }: { error: RemoteFileError; depth: number }): JSX.Element {
  const d = useDict()
  return (
    <div className="file-error" style={{ paddingLeft: 8 + depth * 13 }} role="alert">
      {d.remoteFolders.errors[error]}
    </div>
  )
}

export function FileTree({
  path,
  depth,
  tree,
}: {
  path: string
  depth: number
  tree: TreeContext
}): JSX.Element | null {
  const listing = useListing(path, tree.list)
  if (listing === null) return null
  if ('error' in listing) return <ListingError error={listing.error} depth={depth} />
  return <Listing entries={listing.entries} path={path} depth={depth} tree={tree} />
}

function Listing({
  entries,
  path,
  depth,
  tree,
}: {
  entries: FsEntry[]
  path: string
  depth: number
  tree: TreeContext
}): JSX.Element | null {
  const items = tree.nest(tree.visible(entries, path))
  const edit = useFileTreeStore((s) => s.edit)
  const creating =
    edit?.kind === 'create' && edit.dir === path && !tree.remote ? (
      <NameInputRow
        workspaceId={tree.focus.workspaceId}
        key={`${edit.entry}:${path}`}
        edit={edit}
        depth={depth}
        dir={edit.entry === 'folder'}
        icon={
          <RowIcon entry={{ name: '', dir: edit.entry === 'folder' }} open={false} tree={tree} />
        }
      />
    ) : null
  if (items.length === 0) {
    if (creating) return creating
    return depth === 0 ? (
      <EmptyState variant="surface" size="sm" className="px-3 py-6" desc={tree.emptyText} />
    ) : null
  }
  return (
    <>
      {creating}
      {items.map(({ entry, nested }) =>
        entry.dir || entry.archive ? (
          <DirRow key={entry.name} entry={entry} path={path} depth={depth} tree={tree} />
        ) : (
          <FileRow
            key={entry.name}
            entry={entry}
            nested={nested}
            path={path}
            depth={depth}
            tree={tree}
          />
        ),
      )}
    </>
  )
}

function RowIcon({
  entry,
  open,
  tree,
}: {
  entry: FsEntry
  open: boolean
  tree: TreeContext
}): JSX.Element {
  const src = tree.iconTheme ? themeIconSrc(tree.iconTheme, entry, open, tree.variant) : null
  if (src) {
    return (
      <img src={src} alt="" aria-hidden draggable={false} className="file-icon file-icon-theme" />
    )
  }
  const { Icon, color } = fileIcon(entry, open)
  return <Icon size={16} className="file-icon" style={{ color }} />
}

function RowShell({
  row,
  fullPath,
  dir,
  tree,
}: {
  row: JSX.Element
  fullPath: string
  dir: boolean
  tree: TreeContext
}): JSX.Element {
  const workspaceId = tree.focus.workspaceId
  if (!workspaceId || tree.remote) return row
  return (
    <FileMenu
      workspaceId={workspaceId}
      path={fullPath}
      dir={dir}
      trigger={row}
      visibility={visibilityOf(tree, fullPath)}
    />
  )
}

type ChainState = CompactChain | { error: RemoteFileError }

function useCompactChain(fullPath: string, open: boolean, tree: TreeContext): ChainState | null {
  const [chain, setChain] = useState<ChainState | null>(null)
  const compact = tree.settings.compactFolders
  const { visible, list } = tree
  const version = useFileTreeStore((s) => (s.versions[fullPath] ?? 0) + s.epoch)
  const nestedVersion = useFileTreeStore((s) =>
    chain && !('error' in chain) && chain.path !== fullPath ? (s.versions[chain.path] ?? 0) : 0,
  )
  useEffect(() => {
    void version
    void nestedVersion
    if (!open) return
    let alive = true
    const resolve = compact
      ? compactChain(fullPath, list, visible)
      : list(fullPath).then((entries) => ({ names: [], path: fullPath, entries }))
    resolve.then(
      (next) => {
        if (alive) setChain(next)
      },
      (err: unknown) => {
        if (alive) setChain({ error: listingError(err) })
      },
    )
    return () => {
      alive = false
    }
  }, [fullPath, open, compact, visible, list, version, nestedVersion])
  return chain
}

function DirRow({
  entry,
  path,
  depth,
  tree,
}: {
  entry: FsEntry
  path: string
  depth: number
  tree: TreeContext
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const filePath = childPath(path, entry.name)
  const fullPath = entry.archive ? archiveRoot(filePath) : filePath
  const inside = isArchivePath(filePath)
  const fixed = tree.remote || inside || Boolean(entry.archive)
  const rowRef = useRef<HTMLButtonElement>(null)
  const { activeFile, reveal } = tree.focus
  const holdsActive =
    (activeFile?.startsWith(`${fullPath}/`) ?? false) ||
    (reveal !== null && (reveal === fullPath || reveal.startsWith(`${fullPath}/`)))
  const resolved = useCompactChain(fullPath, open, tree)
  const shownPath = resolved && !('error' in resolved) ? resolved.path : fullPath

  useEffect(() => {
    if (holdsActive) setOpen(true)
  }, [holdsActive])

  useEffect(() => {
    if (reveal === null || reveal !== shownPath) return
    rowRef.current?.scrollIntoView({ block: 'nearest' })
    rowRef.current?.focus()
  }, [reveal, shownPath])
  const failed = resolved && 'error' in resolved ? resolved.error : null
  const chain = resolved && !('error' in resolved) ? resolved : null
  const names = chain ? [entry.name, ...chain.names] : [entry.name]
  const last = names[names.length - 1]
  const excluded = tree.settings.showExcluded && tree.isExcluded(fullPath, tree.root)
  const menuPath = entry.archive ? filePath : (chain?.path ?? fullPath)
  const { renaming, cut } = useRowEdit(menuPath)
  const { over, ...drop } = useFolderDrop(menuPath, tree)
  const creatingHere = useFileTreeStore(
    (s) => s.edit?.kind === 'create' && (s.edit.dir === fullPath || s.edit.dir === menuPath),
  )

  useEffect(() => {
    if (creatingHere) setOpen(true)
  }, [creatingHere])

  const row = renaming ? (
    <NameInputRow
      workspaceId={tree.focus.workspaceId}
      edit={{ kind: 'rename', path: menuPath }}
      depth={depth}
      dir
      icon={<RowIcon entry={{ name: last, dir: true }} open={open} tree={tree} />}
    />
  ) : (
    <button
      ref={rowRef}
      type="button"
      className={`${rowClass(false, excluded, cut)}${over ? ' drop-target' : ''}`}
      aria-expanded={open}
      style={{ paddingLeft: 8 + depth * 13 }}
      draggable={!tree.remote && !inside}
      onDragStart={(e) => startPathDrag(e, menuPath, tree)}
      {...(fixed ? {} : drop)}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => {
        if (
          !tree.remote &&
          !inside &&
          treeRowKey(e, tree.focus.workspaceId, menuPath, !entry.archive)
        ) {
          return
        }
        expandKey(e, setOpen)
      }}
    >
      <CaretRightIcon size={16} className={`file-twisty${open ? ' open' : ''}`} />
      <RowIcon entry={entry.archive ? entry : { name: last, dir: true }} open={open} tree={tree} />
      <span className="file-name">
        {names.map((name, i) => (
          <span key={names.slice(0, i + 1).join('/')}>
            {i > 0 ? <span className="file-name-sep">/</span> : null}
            {name}
          </span>
        ))}
      </span>
    </button>
  )

  return (
    <>
      {renaming || inside ? (
        row
      ) : (
        <RowShell row={row} fullPath={menuPath} dir={!entry.archive} tree={tree} />
      )}
      {open && chain ? (
        <Listing entries={chain.entries} path={chain.path} depth={depth + 1} tree={tree} />
      ) : null}
      {open && failed ? <ListingError error={failed} depth={depth + 1} /> : null}
    </>
  )
}

function FileRow({
  entry,
  nested,
  path,
  depth,
  tree,
}: {
  entry: FsEntry
  nested: FsEntry[]
  path: string
  depth: number
  tree: TreeContext
}): JSX.Element {
  const d = useDict()
  const rowRef = useRef<HTMLButtonElement>(null)
  const fullPath = childPath(path, entry.name)
  const activeFile = tree.focus.activeFile
  const active = fullPath === activeFile
  const holdsActive = nested.some((n) => childPath(path, n.name) === activeFile)
  const [open, setOpen] = useState(false)
  const excluded = tree.settings.showExcluded && tree.isExcluded(fullPath, tree.root)
  const parent = nested.length > 0
  const inside = isArchivePath(fullPath)
  const { renaming, cut } = useRowEdit(fullPath)

  useEffect(() => {
    if (holdsActive) setOpen(true)
  }, [holdsActive])

  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const row = renaming ? (
    <NameInputRow
      workspaceId={tree.focus.workspaceId}
      edit={{ kind: 'rename', path: fullPath }}
      depth={depth}
      dir={false}
      icon={<RowIcon entry={entry} open={false} tree={tree} />}
    />
  ) : (
    <button
      ref={rowRef}
      type="button"
      draggable={!tree.remote && !inside}
      onDragStart={(e) => startPathDrag(e, fullPath, tree)}
      className={rowClass(active, excluded, cut)}
      aria-current={active ? 'true' : undefined}
      aria-expanded={parent ? open : undefined}
      style={{ paddingLeft: 8 + depth * 13 }}
      onClick={(e) => {
        if (parent && isTwisty(e.target)) setOpen((o) => !o)
        else openFileInWorkspace(fullPath)
      }}
      onKeyDown={(e) => {
        if (!tree.remote && !inside && treeRowKey(e, tree.focus.workspaceId, fullPath, false)) {
          return
        }
        if (parent) expandKey(e, setOpen)
      }}
    >
      {parent ? (
        <CaretRightIcon size={16} className={`file-twisty${open ? ' open' : ''}`} />
      ) : (
        <span className="file-twisty-spacer" />
      )}
      <RowIcon entry={entry} open={false} tree={tree} />
      <span className="file-name">
        {entry.link === undefined ? entry.name : `${entry.name} → ${entry.link}`}
      </span>
      {entry.encrypted ? (
        <LockSimpleIcon size={16} className="file-lock" aria-label={d.editor.encryptedEntry} />
      ) : null}
    </button>
  )

  return (
    <>
      {renaming || inside ? (
        row
      ) : (
        <RowShell row={row} fullPath={fullPath} dir={false} tree={tree} />
      )}
      {parent && open
        ? nested.map((child) => (
            <FileRow
              key={child.name}
              entry={child}
              nested={[]}
              path={path}
              depth={depth + 1}
              tree={tree}
            />
          ))
        : null}
    </>
  )
}
