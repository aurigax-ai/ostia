import {
  ArrowClockwiseIcon,
  CaretRightIcon,
  EyeIcon,
  FilePlusIcon,
  FolderPlusIcon,
  MagnifyingGlassIcon,
  SlidersHorizontalIcon,
  XIcon,
} from '@phosphor-icons/react'
import { BUILTIN_ICON_THEME, type LoadedIconTheme } from '@shared/iconTheme'
import { type RemoteFileError, type RemoteFolder, remotePath } from '@shared/remoteFolders'
import type { FsEntry } from '@shared/types'
import {
  type DragEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { findPane } from '../layout/tree'
import { FOLDED_CRUMB, crumbsOf, fitCrumbs, maxFitLevel } from '../lib/breadcrumb'
import { OSTIA_PATH_MIME } from '../lib/dropPaths'
import {
  type CompactChain,
  type ExcludeMatcher,
  type NestedEntry,
  childPath,
  compactChain,
  excludeMatcher,
  isUnderExcluded,
  nestEntries,
  nestingRules,
  sortEntries,
} from '../lib/fileTree'
import { copyInto, moveInto, parentOf } from '../lib/fileTreeActions'
import { homeDir } from '../lib/homeDir'
import { type IconVariant, themeIconSrc } from '../lib/iconTheme'
import { openFileInWorkspace } from '../lib/openFile'
import { useEffectiveTheme } from '../lib/theme'
import { isMac } from '../platform'
import type { FileSortBy, FileSortOrder, FileTreeSettings } from '../settings/fileTreeSettings'
import { useFileTreeStore } from '../stores/fileTreeStore'
import { useActiveIconTheme, useAvailableIconThemes } from '../stores/iconThemeStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useRemoteFoldersStore } from '../stores/remoteFoldersStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { ArtifactsSection } from './ArtifactsSection'
import { FileMenu, type TreeVisibility } from './FileMenu'
import { FileTrashDialog, NameInputRow, treeRowKey } from './FileTreeOps'
import { FilesSearch } from './FilesSearch'
import { Hint, useShortcutHint } from './Hint'
import { IconButton } from './IconButton'
import {
  DropdownMenu,
  MenuCheckboxItem,
  MenuLabel,
  MenuRadioItem,
  MenuSubContent,
  MenuSubTrigger,
} from './Menu'
import { fileIcon } from './fileIcon'
import { Badge } from './ui/badge'
import {
  ContextMenuGroup,
  ContextMenuRadioGroup,
  ContextMenuSeparator,
  ContextMenuSub,
} from './ui/context-menu'
import { Empty, EmptyDescription } from './ui/empty'

interface TreeFocus {
  workspaceId: string | null
  cwd: string
  activeFile: string | null
  reveal: string | null
}

type ListFiles = (path: string) => Promise<FsEntry[]>

interface TreeContext {
  focus: TreeFocus
  root: string
  remote: boolean
  list: ListFiles
  emptyText: string
  settings: FileTreeSettings
  isExcluded: ExcludeMatcher
  nest: (entries: FsEntry[]) => NestedEntry[]
  visible: (entries: FsEntry[], path: string) => FsEntry[]
  iconTheme: LoadedIconTheme | null
  variant: IconVariant
  setExcluded: (path: string, hidden: boolean) => void
}

function useTreeFocus(): TreeFocus {
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const anchor = useWorkspacesStore(
    (s) => s.workspaces.find((c) => c.id === workspaceId)?.workDir ?? '~',
  )
  const layout = useLayoutStore((s) => (workspaceId ? s.byWorkspace[workspaceId] : undefined))
  const pane = layout ? findPane(layout.root, layout.activePaneId) : null
  const editor = pane?.kind === 'editor'
  return {
    workspaceId,
    cwd: editor ? anchor : (pane?.cwd ?? anchor),
    activeFile: editor ? (pane.filePath ?? null) : null,
    reveal: null,
  }
}

function setExcluded(path: string, hidden: boolean): void {
  const { files, setFiles } = useSettingsStore.getState()
  const exclude = hidden
    ? [...files.exclude.filter((p) => p !== path), path]
    : files.exclude.filter((p) => p !== path)
  setFiles({ exclude })
}

class RemoteListError extends Error {
  constructor(readonly code: RemoteFileError) {
    super(code)
  }
}

const listLocal: ListFiles = (path) => window.ostia.fs.list(path)

const listRemote: ListFiles = async (path) => {
  const listing = await window.ostia.remoteFiles.list(path)
  if (!listing.ok) throw new RemoteListError(listing.error)
  return listing.entries
}

function useTreeContext(focus: TreeFocus, remoteRoot?: string): TreeContext {
  const d = useDict()
  const settings = useSettingsStore((s) => s.files)
  const iconTheme = useActiveIconTheme()
  const appearance = useEffectiveTheme()?.appearance
  const root = remoteRoot ?? focus.cwd
  const remote = remoteRoot !== undefined
  const emptyText = remote ? d.remoteFolders.empty : d.rail.noFolder
  return useMemo(() => {
    const isExcluded = excludeMatcher(settings.exclude)
    const rules = settings.nesting.enabled ? nestingRules(settings.nesting.patterns) : []
    const visible = (entries: FsEntry[], path: string): FsEntry[] =>
      sortEntries(
        settings.showExcluded
          ? entries
          : entries.filter((e) => !isExcluded(childPath(path, e.name), root)),
        settings.sortOrder,
        settings.sortBy,
      )
    return {
      focus,
      root,
      remote,
      list: remote ? listRemote : listLocal,
      emptyText,
      settings,
      isExcluded,
      nest: (entries) => nestEntries(entries, rules),
      visible,
      iconTheme,
      variant: appearance === 'light' ? 'light' : 'dark',
      setExcluded,
    }
  }, [focus, root, remote, emptyText, settings, iconTheme, appearance])
}

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
        <div className="file-tree">
          <Dir key={cwd} path={cwd} depth={0} tree={tree} />
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
          <ViewOptionsMenu settings={tree.settings} />
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

function FilesCrumb({ path }: { path: string }): JSX.Element {
  const style = useSettingsStore((s) => s.files.breadcrumb)
  const lineRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const crumbs = useMemo(() => crumbsOf(path, homeDir()), [path])
  const start = style === 'short' ? 1 : 0
  const max = style === 'full' ? 0 : maxFitLevel(crumbs)
  const fitKey = `${style}|${path}|${width}`
  const [fit, setFit] = useState({ key: fitKey, level: start })
  const level = fit.key === fitKey ? fit.level : start
  const shown = fitCrumbs(crumbs, level)

  useEffect(() => {
    const line = lineRef.current
    if (!line) return
    const observer = new ResizeObserver(() => setWidth(line.clientWidth))
    observer.observe(line)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const line = lineRef.current
    if (!line) return
    if (line.scrollWidth <= line.clientWidth) return
    if (level < max) setFit({ key: fitKey, level: level + 1 })
    else line.scrollLeft = line.scrollWidth
  })

  return (
    <div ref={lineRef} className="files-crumb-line" data-style={style}>
      {shown.map((crumb, i) => (
        <span
          key={crumb.key}
          className={`crumb${i === shown.length - 1 ? ' current' : ''}${crumb.key === FOLDED_CRUMB ? ' folded' : ''}`}
        >
          {i > 0 ? <CaretRightIcon size={12} className="crumb-sep" /> : null}
          {crumb.label}
        </span>
      ))}
    </div>
  )
}

function ViewOptionsMenu({ settings }: { settings: FileTreeSettings }): JSX.Element {
  const d = useDict()
  const setFiles = useSettingsStore((s) => s.setFiles)
  const themes = useAvailableIconThemes()
  const themeIds = themes.map((t) => t.id)
  const currentTheme = themeIds.includes(settings.iconTheme)
    ? settings.iconTheme
    : BUILTIN_ICON_THEME
  return (
    <DropdownMenu
      trigger={<IconButton icon={SlidersHorizontalIcon} label={d.filesView.viewOptions} />}
    >
      <MenuCheckboxItem
        checked={settings.compactFolders}
        onCheckedChange={(v) => setFiles({ compactFolders: v })}
      >
        {d.filesView.compactFolders}
      </MenuCheckboxItem>
      <MenuCheckboxItem
        checked={settings.nesting.enabled}
        onCheckedChange={(v) => setFiles({ nesting: { ...settings.nesting, enabled: v } })}
      >
        {d.filesView.nesting}
      </MenuCheckboxItem>
      <MenuCheckboxItem
        checked={settings.showExcluded}
        onCheckedChange={(v) => setFiles({ showExcluded: v })}
      >
        {d.filesView.showExcluded}
      </MenuCheckboxItem>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <MenuLabel>{d.filesView.sort}</MenuLabel>
        <ContextMenuRadioGroup
          value={settings.sortOrder}
          onValueChange={(v) => setFiles({ sortOrder: v as FileSortOrder })}
        >
          <MenuRadioItem value="foldersFirst">{d.filesView.foldersFirst}</MenuRadioItem>
          <MenuRadioItem value="mixed">{d.filesView.mixed}</MenuRadioItem>
        </ContextMenuRadioGroup>
        <ContextMenuSeparator />
        <ContextMenuRadioGroup
          value={settings.sortBy}
          onValueChange={(v) => setFiles({ sortBy: v as FileSortBy })}
        >
          <MenuRadioItem value="name">{d.filesView.byName}</MenuRadioItem>
          <MenuRadioItem value="type">{d.filesView.byType}</MenuRadioItem>
        </ContextMenuRadioGroup>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <MenuSubTrigger>{d.filesView.iconTheme}</MenuSubTrigger>
        <MenuSubContent>
          <ContextMenuRadioGroup
            value={currentTheme}
            onValueChange={(v) => setFiles({ iconTheme: String(v) })}
          >
            <MenuRadioItem value={BUILTIN_ICON_THEME}>{d.filesView.builtinIcons}</MenuRadioItem>
            {themes.map((t) => (
              <MenuRadioItem key={t.id} value={t.id}>
                {t.label}
              </MenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </MenuSubContent>
      </ContextMenuSub>
    </DropdownMenu>
  )
}

type DirListing = { entries: FsEntry[] } | { error: RemoteFileError }

function listingError(err: unknown): RemoteFileError {
  return err instanceof RemoteListError ? err.code : 'failed'
}

function useListing(path: string, list: ListFiles): DirListing | null {
  const [listing, setListing] = useState<DirListing | null>(null)
  const version = useFileTreeStore((s) => s.versions[path] ?? 0)
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

function RemoteFolderSection({
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
          <CaretRightIcon size={12} className={`file-twisty${open ? ' open' : ''}`} />
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
        <div className="file-tree remote-folder-tree">
          <Dir key={`${root}#${generation}`} path={root} depth={0} tree={tree} />
        </div>
      ) : null}
    </section>
  )
}

function Dir({
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
      <Empty className="px-3 py-6">
        <EmptyDescription className="text-ui-sm">{tree.emptyText}</EmptyDescription>
      </Empty>
    ) : null
  }
  return (
    <>
      {creating}
      {items.map(({ entry, nested }) =>
        entry.dir ? (
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

function visibilityOf(tree: TreeContext, fullPath: string): TreeVisibility | undefined {
  const literal = tree.settings.exclude.includes(fullPath)
  if (!literal && tree.isExcluded(fullPath, tree.root)) return undefined
  return { hidden: literal, toggle: () => tree.setExcluded(fullPath, !literal) }
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

function isTwisty(target: EventTarget): boolean {
  return target instanceof Element && target.closest('.file-twisty') !== null
}

function expandKey(e: KeyboardEvent<HTMLButtonElement>, setOpen: (open: boolean) => void): void {
  if (e.key === 'ArrowRight') setOpen(true)
  else if (e.key === 'ArrowLeft') setOpen(false)
  else return
  e.preventDefault()
}

function rowClass(active: boolean, excluded: boolean, cut = false): string {
  return `file-row${active ? ' active' : ''}${excluded ? ' excluded' : ''}${cut ? ' cut' : ''}`
}

function useRowEdit(fullPath: string): { renaming: boolean; cut: boolean } {
  const renaming = useFileTreeStore((s) => s.edit?.kind === 'rename' && s.edit.path === fullPath)
  const cut = useFileTreeStore(
    (s) => s.clipboard?.mode === 'cut' && s.clipboard.paths.includes(fullPath),
  )
  return { renaming, cut }
}

function startPathDrag(e: DragEvent<HTMLElement>, fullPath: string, tree: TreeContext): void {
  if (tree.remote) {
    e.preventDefault()
    return
  }
  e.dataTransfer.setData(OSTIA_PATH_MIME, fullPath)
  e.dataTransfer.setData('text/plain', fullPath)
  e.dataTransfer.effectAllowed = 'copyMove'
}

function isCopyDrop(e: DragEvent<HTMLElement>): boolean {
  return isMac ? e.altKey : e.ctrlKey
}

function useFolderDrop(
  dir: string,
  tree: TreeContext,
): Pick<HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'> & { over: boolean } {
  const [over, setOver] = useState(false)
  const workspaceId = tree.focus.workspaceId
  if (tree.remote || !workspaceId) return { over: false }
  return {
    over,
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(OSTIA_PATH_MIME)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = isCopyDrop(e) ? 'copy' : 'move'
      setOver(true)
    },
    onDragLeave: () => setOver(false),
    onDrop: (e) => {
      setOver(false)
      const source = e.dataTransfer.getData(OSTIA_PATH_MIME)
      if (!source) return
      e.preventDefault()
      e.stopPropagation()
      if (isCopyDrop(e)) void copyInto(workspaceId, [source], dir)
      else if (parentOf(source) !== dir) void moveInto(workspaceId, [source], dir)
    },
  }
}

type ChainState = CompactChain | { error: RemoteFileError }

function useCompactChain(fullPath: string, open: boolean, tree: TreeContext): ChainState | null {
  const [chain, setChain] = useState<ChainState | null>(null)
  const compact = tree.settings.compactFolders
  const { visible, list } = tree
  const version = useFileTreeStore((s) => s.versions[fullPath] ?? 0)
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
  const fullPath = childPath(path, entry.name)
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
  const menuPath = chain?.path ?? fullPath
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
      draggable={!tree.remote}
      onDragStart={(e) => startPathDrag(e, menuPath, tree)}
      {...drop}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => {
        if (!tree.remote && treeRowKey(e, tree.focus.workspaceId, menuPath, true)) return
        expandKey(e, setOpen)
      }}
    >
      <CaretRightIcon size={12} className={`file-twisty${open ? ' open' : ''}`} />
      <RowIcon entry={{ name: last, dir: true }} open={open} tree={tree} />
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
      {renaming ? row : <RowShell row={row} fullPath={menuPath} dir tree={tree} />}
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
  const rowRef = useRef<HTMLButtonElement>(null)
  const fullPath = childPath(path, entry.name)
  const activeFile = tree.focus.activeFile
  const active = fullPath === activeFile
  const holdsActive = nested.some((n) => childPath(path, n.name) === activeFile)
  const [open, setOpen] = useState(false)
  const excluded = tree.settings.showExcluded && tree.isExcluded(fullPath, tree.root)
  const parent = nested.length > 0
  const { renaming, cut } = useRowEdit(fullPath)

  useEffect(() => {
    if (holdsActive) setOpen(true)
  }, [holdsActive])

  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const row = renaming ? (
    <NameInputRow
      edit={{ kind: 'rename', path: fullPath }}
      depth={depth}
      dir={false}
      icon={<RowIcon entry={entry} open={false} tree={tree} />}
    />
  ) : (
    <button
      ref={rowRef}
      type="button"
      draggable={!tree.remote}
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
        if (!tree.remote && treeRowKey(e, tree.focus.workspaceId, fullPath, false)) return
        if (parent) expandKey(e, setOpen)
      }}
    >
      {parent ? (
        <CaretRightIcon size={12} className={`file-twisty${open ? ' open' : ''}`} />
      ) : (
        <span className="file-twisty-spacer" />
      )}
      <RowIcon entry={entry} open={false} tree={tree} />
      <span className="file-name">{entry.name}</span>
    </button>
  )

  return (
    <>
      {renaming ? row : <RowShell row={row} fullPath={fullPath} dir={false} tree={tree} />}
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
