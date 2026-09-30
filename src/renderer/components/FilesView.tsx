import { CaretRightIcon, XIcon } from '@phosphor-icons/react'
import type { FsEntry } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { findPane } from '../layout/tree'
import { openFileInWorkspace } from '../lib/openFile'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { FileMenu } from './FileMenu'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { fileIcon } from './fileIcon'
import { Empty, EmptyDescription } from './ui/empty'

interface TreeFocus {
  workspaceId: string | null
  cwd: string
  activeFile: string | null
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

function childPath(path: string, name: string): string {
  return path.endsWith('/') ? path + name : `${path}/${name}`
}

export function FilesView(): JSX.Element {
  const d = useDict()
  const focus = useTreeFocus()
  const cwd = focus.cwd
  const segments = cwd.split('/').filter(Boolean)

  return (
    <>
      <div className="rail-section files-head">
        <span>{d.rail.files}</span>
        <IconButton
          icon={XIcon}
          label={d.rail.closeFiles}
          className="files-close"
          onClick={() => useUIStore.getState().toggleFiles()}
        />
      </div>
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
        <Dir key={cwd} path={cwd} depth={0} focus={focus} />
      </div>
    </>
  )
}

function Dir({
  path,
  depth,
  focus,
}: {
  path: string
  depth: number
  focus: TreeFocus
}): JSX.Element | null {
  const d = useDict()
  const showHidden = useSettingsStore((s) => s.behavior.showHiddenFiles)
  const [entries, setEntries] = useState<FsEntry[] | null>(null)

  useEffect(() => {
    let alive = true
    window.pine.fs.list(path).then((list) => {
      if (alive) setEntries(list)
    })
    return () => {
      alive = false
    }
  }, [path])

  if (entries === null) return null
  const visible = showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'))
  if (visible.length === 0) {
    return depth === 0 ? (
      <Empty className="px-3 py-6">
        <EmptyDescription className="text-ui-sm">{d.rail.noFolder}</EmptyDescription>
      </Empty>
    ) : null
  }
  return (
    <>
      {visible.map((entry) => (
        <Row key={entry.name} entry={entry} path={path} depth={depth} focus={focus} />
      ))}
    </>
  )
}

function Row({
  entry,
  path,
  depth,
  focus,
}: {
  entry: FsEntry
  path: string
  depth: number
  focus: TreeFocus
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const rowRef = useRef<HTMLButtonElement>(null)
  const { Icon, color } = fileIcon(entry, open)
  const fullPath = childPath(path, entry.name)
  const active = !entry.dir && fullPath === focus.activeFile

  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const row = (
    <button
      ref={rowRef}
      type="button"
      className={`file-row${active ? ' active' : ''}`}
      aria-current={active ? 'true' : undefined}
      style={{ paddingLeft: 8 + depth * 13 }}
      onClick={() => {
        if (entry.dir) {
          setOpen((o) => !o)
        } else {
          openFileInWorkspace(fullPath)
        }
      }}
    >
      {entry.dir ? (
        <CaretRightIcon size={12} className={`file-twisty${open ? ' open' : ''}`} />
      ) : (
        <span className="file-twisty-spacer" />
      )}
      <Icon size={14} className="file-icon" style={{ color }} />
      <span className="file-name">{entry.name}</span>
    </button>
  )

  return (
    <>
      {focus.workspaceId ? (
        <FileMenu workspaceId={focus.workspaceId} path={fullPath} dir={entry.dir} trigger={row} />
      ) : (
        row
      )}
      {entry.dir && open ? <Dir path={fullPath} depth={depth + 1} focus={focus} /> : null}
    </>
  )
}
