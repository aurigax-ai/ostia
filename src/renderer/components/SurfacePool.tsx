import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { allPanes } from '../layout/tree'
import type { LayoutNode, SurfaceKind } from '../layout/types'
import { useDiffStore } from '../stores/diffStore'
import { useLayoutStore } from '../stores/layoutStore'
import { releaseSurfaces, surfaceHost } from '../stores/surfaceSlotsStore'
import { BrowserView } from './BrowserView'
import { DiffView } from './DiffView'
import { EditorView } from './Editor'
import { ExtensionPanelView } from './ExtensionPanelView'
import { TerminalView } from './Terminal'

interface SurfaceRef {
  paneId: string
  sessionId: string
  kind: SurfaceKind
  cwd?: string
  filePath?: string
  url?: string
  extensionId?: string
}

function collect(node: LayoutNode, sessionId: string, out: SurfaceRef[]): void {
  for (const pane of allPanes(node)) {
    if (
      pane.kind === 'terminal' ||
      pane.kind === 'editor' ||
      pane.kind === 'browser' ||
      pane.kind === 'diff' ||
      (pane.kind === 'extension' && pane.extensionId)
    ) {
      out.push({
        paneId: pane.id,
        sessionId,
        kind: pane.kind,
        cwd: pane.cwd,
        filePath: pane.filePath,
        url: pane.url,
        extensionId: pane.extensionId,
      })
    }
  }
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
    const live = new Set(surfaces.map((s) => s.paneId))
    releaseSurfaces(live)
    useDiffStore.getState().retain(live)
  }, [surfaces])

  return (
    <>
      {surfaces.map((s) =>
        createPortal(
          s.kind === 'editor' ? (
            <EditorView paneId={s.paneId} filePath={s.filePath} />
          ) : s.kind === 'diff' ? (
            <DiffView paneId={s.paneId} />
          ) : s.kind === 'browser' ? (
            <BrowserView sessionId={s.sessionId} paneId={s.paneId} url={s.url} />
          ) : s.kind === 'extension' && s.extensionId ? (
            <ExtensionPanelView extId={s.extensionId} sessionId={s.sessionId} />
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
