import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { LayoutNode, SurfaceKind } from '../layout/types'
import { useLayoutStore } from '../stores/layoutStore'
import { releaseSurfaces, surfaceHost } from '../stores/surfaceSlotsStore'
import { BrowserView } from './BrowserView'
import { EditorView } from './Editor'
import { KanbanView } from './KanbanView'
import { TerminalView } from './Terminal'
import { WikiView } from './WikiView'

interface SurfaceRef {
  paneId: string
  sessionId: string
  kind: SurfaceKind
  cwd?: string
  filePath?: string
  url?: string
}

function collect(node: LayoutNode, sessionId: string, out: SurfaceRef[]): void {
  if (node.type === 'pane') {
    if (
      node.kind === 'terminal' ||
      node.kind === 'editor' ||
      node.kind === 'browser' ||
      node.kind === 'kanban' ||
      node.kind === 'wiki'
    ) {
      out.push({
        paneId: node.id,
        sessionId,
        kind: node.kind,
        cwd: node.cwd,
        filePath: node.filePath,
        url: node.url,
      })
    }
    return
  }
  for (const child of node.children) collect(child, sessionId, out)
}

export function SurfacePool(): JSX.Element {
  const bySession = useLayoutStore((s) => s.bySession)

  const surfaces = useMemo(() => {
    const out: SurfaceRef[] = []
    for (const [sessionId, layout] of Object.entries(bySession)) {
      if (layout) collect(layout.root, sessionId, out)
    }
    return out
  }, [bySession])

  useEffect(() => {
    releaseSurfaces(new Set(surfaces.map((s) => s.paneId)))
  }, [surfaces])

  return (
    <>
      {surfaces.map((s) =>
        createPortal(
          s.kind === 'editor' ? (
            <EditorView filePath={s.filePath} />
          ) : s.kind === 'browser' ? (
            <BrowserView sessionId={s.sessionId} paneId={s.paneId} url={s.url} />
          ) : s.kind === 'kanban' ? (
            <KanbanView sessionId={s.sessionId} />
          ) : s.kind === 'wiki' ? (
            <WikiView sessionId={s.sessionId} />
          ) : (
            <TerminalView sessionId={s.sessionId} paneId={s.paneId} cwd={s.cwd} />
          ),
          surfaceHost(s.paneId),
          s.paneId,
        ),
      )}
    </>
  )
}
