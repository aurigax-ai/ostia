import {
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  CloudIcon,
  FolderIcon,
  FolderOpenIcon,
  ListBulletsIcon,
  MinusIcon,
  PlusIcon,
  TreeStructureIcon,
} from '@phosphor-icons/react'
import type { Dict } from '@shared/dict'
import type {
  BranchInfo,
  ChangeArea,
  ChangesView,
  FileChange,
  GitChangesData,
  GitPathsRequest,
  StatusSummary,
} from '@shared/git'
import { Fragment, type KeyboardEvent, type ReactNode, useMemo } from 'react'
import { fmt, useDict } from '../../i18n/useDict'
import { type TreeNode, buildFileTree } from '../../lib/gitFileTree'
import { AREA_ORDER, leaves, rowIndent, splitPath } from '../../lib/gitView'
import { useSettingsStore } from '../../stores/settingsStore'
import { IconButton } from '../IconButton'

type GitDict = Dict['git']

export interface FileItem {
  path: string
  code: string
  origPath?: string
}

export interface FolderState {
  collapsed: ReadonlySet<string>
  setOpen: (key: string, open: boolean) => void
}

export interface ChangeHandlers {
  open: (path: string, area: ChangeArea) => void
  stage: (req: GitPathsRequest) => void
  unstage: (req: GitPathsRequest) => void
  discard: (req: GitPathsRequest) => void
}

export function areaLabel(t: GitDict, area: ChangeArea): string {
  const labels: Record<ChangeArea, string> = {
    conflicted: t.areaConflicted,
    staged: t.areaStaged,
    unstaged: t.areaUnstaged,
    untracked: t.areaUntracked,
  }
  return labels[area]
}

export function codeLabel(t: GitDict, code: string): string {
  const labels: Record<string, string> = {
    M: t.codeM,
    A: t.codeA,
    D: t.codeD,
    R: t.codeR,
    C: t.codeC,
    T: t.codeT,
    U: t.codeU,
    '?': t.codeUntracked,
  }
  return labels[code] ?? code
}

function CodeBadge({ code }: { code: string }): JSX.Element {
  const t = useDict().git
  return (
    <span
      className={`code code-${code === '?' ? 'u' : code}`}
      title={codeLabel(t, code)}
      aria-hidden
    >
      {code}
    </span>
  )
}

export function ViewToggle(): JSX.Element {
  const t = useDict().git
  const view = useSettingsStore((s) => s.git.changesView)
  const choose = (next: ChangesView): void => {
    if (next !== view) useSettingsStore.getState().setGit({ changesView: next })
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar group of two toggles, not a form fieldset
    <div className="segmented" role="group" aria-label={t.viewAs}>
      <IconButton
        icon={ListBulletsIcon}
        label={t.viewList}
        aria-pressed={view === 'list'}
        onClick={() => choose('list')}
      />
      <IconButton
        icon={TreeStructureIcon}
        label={t.viewTree}
        aria-pressed={view === 'tree'}
        onClick={() => choose('tree')}
      />
    </div>
  )
}

export function Tracking({ branch }: { branch: BranchInfo }): JSX.Element {
  const t = useDict().git
  if (!branch.upstream) return <span className="tracking muted">{t.noUpstream}</span>
  const moved = branch.ahead > 0 || branch.behind > 0
  const title = moved
    ? fmt(t.aheadBehind, { ahead: branch.ahead, behind: branch.behind, name: branch.upstream })
    : `${fmt(t.upstream, { name: branch.upstream })}: ${t.inSync}`
  return (
    <span className="tracking" title={title}>
      <span className="upstream muted">
        <CloudIcon />
        {branch.upstream}
      </span>
      {branch.ahead > 0 ? (
        <span className="count ahead">
          <ArrowUpIcon />
          {branch.ahead}
        </span>
      ) : null}
      {branch.behind > 0 ? (
        <span className="count behind">
          <ArrowDownIcon />
          {branch.behind}
        </span>
      ) : null}
      {moved ? null : (
        <span className="count synced">
          <CheckIcon />
          {t.inSync}
        </span>
      )}
    </span>
  )
}

export function CountChips({ counts }: { counts: StatusSummary }): JSX.Element {
  const t = useDict().git
  return (
    <span className="wt-counts">
      {counts.conflicted > 0 ? (
        <span className="wt-count conflicted">
          {counts.conflicted === 1
            ? t.countOneConflict
            : fmt(t.countConflicts, { count: counts.conflicted })}
        </span>
      ) : null}
      {counts.staged > 0 ? (
        <span className="wt-count staged">{fmt(t.countStaged, { count: counts.staged })}</span>
      ) : null}
      {counts.unstaged > 0 ? (
        <span className="wt-count unstaged">
          {fmt(t.countUnstaged, { count: counts.unstaged })}
        </span>
      ) : null}
      {counts.untracked > 0 ? (
        <span className="wt-count untracked">
          {fmt(t.countUntracked, { count: counts.untracked })}
        </span>
      ) : null}
    </span>
  )
}

function moveRowFocus(e: KeyboardEvent<HTMLUListElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('button.change, button.folder')]
  const at = rows.indexOf(document.activeElement as HTMLElement)
  const next = rows[at + (e.key === 'ArrowDown' ? 1 : -1)]
  if (!next) return
  e.preventDefault()
  next.focus()
}

interface ListProps<T extends FileItem> {
  scopeKey: string
  label: (item: T) => string
  onOpen: (item: T) => void
  actions?: (items: T[], folder: string | null) => ReactNode
}

function FileRow<T extends FileItem>({
  item,
  depth,
  scopeKey,
  label,
  onOpen,
  actions,
}: ListProps<T> & { item: T; depth: number | null }): JSX.Element {
  const { name, dir } = splitPath(item.path)
  return (
    <li className="row" data-area={scopeKey}>
      <button
        type="button"
        className="change"
        data-path={item.path}
        aria-label={label(item)}
        title={item.origPath ? `${item.origPath} → ${item.path}` : item.path}
        style={depth === null ? undefined : { paddingLeft: rowIndent(depth) + 16 }}
        onClick={() => onOpen(item)}
      >
        <CodeBadge code={item.code} />
        <span className="name">{name}</span>
        {depth === null && dir ? <span className="dir muted">{dir}</span> : null}
      </button>
      {actions?.([item], null)}
    </li>
  )
}

function TreeRows<T extends FileItem>({
  nodes,
  depth,
  folders,
  ...list
}: ListProps<T> & { nodes: TreeNode<T>[]; depth: number; folders: FolderState }): JSX.Element {
  const t = useDict().git
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'file') {
          return <FileRow key={`file:${node.path}`} item={node.item} depth={depth} {...list} />
        }
        const key = `${list.scopeKey}:${node.path}`
        const open = !folders.collapsed.has(key)
        return (
          <Fragment key={`folder:${node.path}`}>
            <li className="row folder-row">
              <button
                type="button"
                className="folder"
                data-folder={node.path}
                aria-expanded={open}
                title={node.path}
                style={{ paddingLeft: rowIndent(depth) }}
                onClick={() => folders.setOpen(key, !open)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
                  e.preventDefault()
                  folders.setOpen(key, e.key === 'ArrowRight')
                }}
              >
                <span className="caret">{open ? <CaretDownIcon /> : <CaretRightIcon />}</span>
                <span className="folder-icon">{open ? <FolderOpenIcon /> : <FolderIcon />}</span>
                <span className="name">{node.name}</span>
                <span
                  className="folder-count"
                  title={node.count === 1 ? t.oneFile : fmt(t.manyFiles, { count: node.count })}
                >
                  {node.count}
                </span>
              </button>
              {list.actions?.(leaves(node), node.path)}
            </li>
            {open ? (
              <TreeRows nodes={node.children} depth={depth + 1} folders={folders} {...list} />
            ) : null}
          </Fragment>
        )
      })}
    </>
  )
}

export function FileList<T extends FileItem>({
  items,
  folders,
  ...list
}: ListProps<T> & { items: T[]; folders: FolderState }): JSX.Element {
  const view = useSettingsStore((s) => s.git.changesView)
  const tree = useMemo(() => (view === 'tree' ? buildFileTree(items) : null), [view, items])
  return (
    <ul className="files" onKeyDown={moveRowFocus}>
      {tree ? (
        <TreeRows nodes={tree} depth={0} folders={folders} {...list} />
      ) : (
        items.map((item) => <FileRow key={item.path} item={item} depth={null} {...list} />)
      )}
    </ul>
  )
}

function absolutePaths(data: GitChangesData, items: FileChange[]): GitPathsRequest {
  return { paths: items.map((c) => `${data.root}/${c.path}`), all: false }
}

const EVERYTHING: GitPathsRequest = { paths: [], all: true }

function RowActions({
  data,
  area,
  items,
  folder,
  handlers,
}: {
  data: GitChangesData
  area: ChangeArea
  items: FileChange[]
  folder: string | null
  handlers: ChangeHandlers
}): JSX.Element {
  const t = useDict().git
  const what = folder ?? items[0]?.path ?? ''
  const req = absolutePaths(data, items)
  return (
    <span className="actions">
      {area === 'unstaged' || area === 'untracked' ? (
        <IconButton
          icon={ArrowCounterClockwiseIcon}
          label={`${folder ? t.discardFolder : t.discard}: ${what}`}
          onClick={() => handlers.discard(req)}
        />
      ) : null}
      {area === 'staged' ? (
        <IconButton
          icon={MinusIcon}
          label={`${folder ? t.unstageFolder : t.unstage}: ${what}`}
          onClick={() => handlers.unstage(req)}
        />
      ) : (
        <IconButton
          icon={PlusIcon}
          label={`${folder ? t.stageFolder : t.stage}: ${what}`}
          onClick={() => handlers.stage(req)}
        />
      )}
    </span>
  )
}

function AreaActions({
  area,
  handlers,
}: { area: ChangeArea; handlers: ChangeHandlers }): JSX.Element | null {
  const t = useDict().git
  if (area === 'conflicted') return null
  if (area === 'staged') {
    return (
      <span className="actions">
        <IconButton
          icon={MinusIcon}
          label={t.unstageAll}
          onClick={() => handlers.unstage(EVERYTHING)}
        />
      </span>
    )
  }
  return (
    <span className="actions">
      <IconButton
        icon={ArrowCounterClockwiseIcon}
        label={`${t.discardAll}: ${areaLabel(t, area)}`}
        onClick={() => handlers.discard(EVERYTHING)}
      />
      <IconButton
        icon={PlusIcon}
        label={`${t.stageAll}: ${areaLabel(t, area)}`}
        onClick={() => handlers.stage(EVERYTHING)}
      />
    </span>
  )
}

export function ChangeSections({
  data,
  keyPrefix,
  folders,
  handlers,
}: {
  data: GitChangesData
  keyPrefix: string
  folders: FolderState
  handlers: ChangeHandlers
}): JSX.Element {
  const t = useDict().git
  const byArea = useMemo(
    () => AREA_ORDER.map((area) => ({ area, items: data.changes.filter((c) => c.area === area) })),
    [data.changes],
  )
  return (
    <>
      {byArea.map(({ area, items }) =>
        items.length === 0 ? null : (
          <section key={area} className={`area area-${area}`} aria-label={areaLabel(t, area)}>
            <h2>
              <span className="area-title">{areaLabel(t, area)}</span>
              <span className="area-count">{items.length}</span>
              <span className="spacer" />
              <AreaActions area={area} handlers={handlers} />
            </h2>
            <FileList
              items={items}
              folders={folders}
              scopeKey={`${keyPrefix}${area}`}
              label={(c) => `${t.openDiff}: ${c.path} (${codeLabel(t, c.code)})`}
              onOpen={(c) => handlers.open(`${data.root}/${c.path}`, c.area)}
              actions={(list, folder) => (
                <RowActions
                  data={data}
                  area={area}
                  items={list}
                  folder={folder}
                  handlers={handlers}
                />
              )}
            />
          </section>
        ),
      )}
    </>
  )
}
