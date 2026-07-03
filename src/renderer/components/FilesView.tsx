import type { FsEntry } from '@shared/types'
import { ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { findPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { fileIcon } from './fileIcon'

/**
 * The cwd the Files explorer shows: the **focused pane's** cwd (kept live by the
 * terminal — see Terminal.tsx / pty cwd tracking), falling back to the session's
 * workDir anchor. Re-derives on pane focus / session switch, so it follows the
 * terminal you're looking at.
 */
function useFocusedCwd(): string {
  const sessionId = useSessionsStore((s) => s.activeSessionId)
  const anchor = useSessionsStore((s) => s.sessions.find((c) => c.id === sessionId)?.workDir ?? '~')
  const layout = useLayoutStore((s) => s.bySession[sessionId])
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
      <div className="files-crumb" title={cwd}>
        {segments.map((seg, i) => (
          <span
            key={segments.slice(0, i + 1).join('/')}
            className={`crumb${i === segments.length - 1 ? ' current' : ''}`}
          >
            {i > 0 ? <ChevronRight size={11} className="crumb-sep" /> : null}
            {seg}
          </span>
        ))}
      </div>
      {/* keyed by cwd so the tree resets (and re-reads) when the root changes */}
      <div className="file-tree">
        <Dir key={cwd} path={cwd} depth={0} />
      </div>
    </>
  )
}

/** Lazily lists a directory over the `fs.list` bridge; renders its entries. */
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

  if (entries === null) return null // loading
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
            const sessionId = useSessionsStore.getState().activeSessionId
            useLayoutStore.getState().openFile(sessionId, childPath(path, entry.name))
          }
        }}
      >
        {entry.dir ? (
          <ChevronRight size={12} className={`file-twisty${open ? ' open' : ''}`} />
        ) : (
          <span className="file-twisty-spacer" />
        )}
        <Icon size={13} className="file-icon" style={{ color }} />
        <span className="file-name">{entry.name}</span>
      </button>
      {entry.dir && open ? <Dir path={childPath(path, entry.name)} depth={depth + 1} /> : null}
    </>
  )
}
