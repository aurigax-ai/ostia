import {
  ArrowClockwiseIcon,
  CaretRightIcon,
  EyeIcon,
  SlidersHorizontalIcon,
  XIcon,
} from '@phosphor-icons/react'
import { BUILTIN_ICON_THEME, type LoadedIconTheme } from '@shared/iconTheme'
import { type RemoteFileError, type RemoteFolder, remotePath } from '@shared/remoteFolders'
import type { FsEntry } from '@shared/types'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { findPane } from '../layout/tree'
import { OSTIA_PATH_MIME } from '../lib/dropPaths'
import {
  type CompactChain,
  type ExcludeMatcher,
  type NestedEntry,
  childPath,
  compactChain,
  excludeMatcher,
  nestEntries,
  nestingRules,
  sortEntries,
} from '../lib/fileTree'
import { type IconVariant, themeIconSrc } from '../lib/iconTheme'
import { openFileInWorkspace } from '../lib/openFile'
import { useEffectiveTheme } from '../lib/theme'
import type { FileSortBy, FileSortOrder, FileTreeSettings } from '../settings/fileTreeSettings'
import { useActiveIconTheme, useAvailableIconThemes } from '../stores/iconThemeStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useRemoteFoldersStore } from '../stores/remoteFoldersStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { FileMenu, type TreeVisibility } from './FileMenu'
import { Hint } from './Hint'
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
  return {
    workspaceId,
    cwd: pane?.cwd ?? anchor,
    activeFile: pane?.kind === 'editor' ? (pane.filePath ?? null) : null,
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
  const stableFocus = useMemo(
    () => ({ workspaceId, cwd, activeFile }),
    [workspaceId, cwd, activeFile],
  )
  const tree = useTreeContext(stableFocus)
  const segments = cwd.split('/').filter(Boolean)
  const allFolders = useRemoteFoldersStore((s) => s.folders)
  const folders = useMemo(
    () => allFolders.filter((folder) => folder.workspaceId === workspaceId),
    [allFolders, workspaceId],
  )

  const local = (
    <>
      <Hint label={cwd} side="bottom">
        <div className="files-crumb">
          {segments.map((seg, i) => (
            <span
              key={segments.slice(0, i + 1).join('/')}
              className={`crumb${i === segments.length - 1 ? ' current' : ''}`}
            >
              {i > 0 ? <CaretRightIcon size={12} className="crumb-sep" /> : null}
              {seg}
            </span>
          ))}
        </div>
      </Hint>
      <div className="file-tree">
        <Dir key={cwd} path={cwd} depth={0} tree={tree} />
      </div>
    </>
  )

  return (
    <>
      <div className="rail-section files-head">
        <span>{d.rail.files}</span>
        <div className="files-toolbar">
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
    </>
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
  useEffect(() => {
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
  }, [path, list])
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
  if (items.length === 0) {
    return depth === 0 ? (
      <Empty className="px-3 py-6">
        <EmptyDescription className="text-ui-sm">{tree.emptyText}</EmptyDescription>
      </Empty>
    ) : null
  }
  return (
    <>
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

function rowClass(active: boolean, excluded: boolean): string {
  return `file-row${active ? ' active' : ''}${excluded ? ' excluded' : ''}`
}

type ChainState = CompactChain | { error: RemoteFileError }

function useCompactChain(fullPath: string, open: boolean, tree: TreeContext): ChainState | null {
  const [chain, setChain] = useState<ChainState | null>(null)
  const compact = tree.settings.compactFolders
  const { visible, list } = tree
  useEffect(() => {
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
  }, [fullPath, open, compact, visible, list])
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
  const resolved = useCompactChain(fullPath, open, tree)
  const failed = resolved && 'error' in resolved ? resolved.error : null
  const chain = resolved && !('error' in resolved) ? resolved : null
  const names = chain ? [entry.name, ...chain.names] : [entry.name]
  const last = names[names.length - 1]
  const excluded = tree.settings.showExcluded && tree.isExcluded(fullPath, tree.root)

  const row = (
    <button
      type="button"
      className={rowClass(false, excluded)}
      aria-expanded={open}
      style={{ paddingLeft: 8 + depth * 13 }}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => expandKey(e, setOpen)}
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
      <RowShell row={row} fullPath={chain?.path ?? fullPath} dir tree={tree} />
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

  useEffect(() => {
    if (holdsActive) setOpen(true)
  }, [holdsActive])

  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const row = (
    <button
      ref={rowRef}
      type="button"
      draggable={!tree.remote}
      onDragStart={(e) => {
        if (tree.remote) {
          e.preventDefault()
          return
        }
        e.dataTransfer.setData(OSTIA_PATH_MIME, fullPath)
        e.dataTransfer.setData('text/plain', fullPath)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      className={rowClass(active, excluded)}
      aria-current={active ? 'true' : undefined}
      aria-expanded={parent ? open : undefined}
      style={{ paddingLeft: 8 + depth * 13 }}
      onClick={(e) => {
        if (parent && isTwisty(e.target)) setOpen((o) => !o)
        else openFileInWorkspace(fullPath)
      }}
      onKeyDown={parent ? (e) => expandKey(e, setOpen) : undefined}
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
      <RowShell row={row} fullPath={fullPath} dir={false} tree={tree} />
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
