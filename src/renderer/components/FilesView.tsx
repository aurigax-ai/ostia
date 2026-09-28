import type { FsEntry } from '@shared/types'
import { ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { findPane } from '../layout/tree'
import { openFileInWorkspace } from '../lib/openFile'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { Hint } from './Hint'
import { fileIcon } from './fileIcon'

function useFocusedCwd(): string {
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const anchor = useWorkspacesStore(
    (s) => s.workspaces.find((c) => c.id === workspaceId)?.workDir ?? '~',
  )
  const layout = useLayoutStore((s) => (workspaceId ? s.byWorkspace[workspaceId] : undefined))
  return layout ? (findPane(layout.root, layout.activePaneId)?.cwd ?? anchor) : anchor
}

function childPath(path: string, name: string): string {
  return path.endsWith('/') ? path + name : `${path}/${name}`
}

export function FilesView(): JSX.Element {
  const d = useDict()
  const cwd = useFocusedCwd()
  const segments = cwd.split('/').filter(Boolean)

  return (
    <>
      <div className="rail-section">{d.rail.files}</div>
      <Hint label={cwd} side="bottom">
        <div className="files-crumb">
          {segments.map((seg, i) => (
            <span
              key={segments.slice(0, i + 1).join('/')}
              className={`crumb${i === segments.length - 1 ? ' current' : ''}`}
            >
              {i > 0 ? <ChevronRight size={12} className="crumb-sep" /> : null}
              {seg}
            </span>
          ))}
        </div>
      </Hint>
      <div className="file-tree">
        <Dir key={cwd} path={cwd} depth={0} />
      </div>
    </>
  )
}

function Dir({ path, depth }: { path: string; depth: number }): JSX.Element | null {
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
    return depth === 0 ? <div className="rail-empty">{d.rail.noFolder}</div> : null
  }
  return (
    <>
      {visible.map((entry) => (
        <Row key={entry.name} entry={entry} path={path} depth={depth} />
      ))}
    </>
  )
}

function Row({ entry, path, depth }: { entry: FsEntry; path: string; depth: number }): JSX.Element {
  const [open, setOpen] = useState(false)
  const { Icon, color } = fileIcon(entry, open)
  return (
    <>
      <button
        type="button"
        className="file-row"
        style={{ paddingLeft: 8 + depth * 13 }}
        onClick={() => {
          if (entry.dir) {
            setOpen((o) => !o)
          } else {
            openFileInWorkspace(childPath(path, entry.name))
          }
        }}
      >
        {entry.dir ? (
          <ChevronRight size={12} className={`file-twisty${open ? ' open' : ''}`} />
        ) : (
          <span className="file-twisty-spacer" />
        )}
        <Icon size={14} className="file-icon" style={{ color }} />
        <span className="file-name">{entry.name}</span>
      </button>
      {entry.dir && open ? <Dir path={childPath(path, entry.name)} depth={depth + 1} /> : null}
    </>
  )
}
