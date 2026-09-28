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
  workspaceId: string
  kind: SurfaceKind
  cwd?: string
  filePath?: string
  url?: string
  extensionId?: string
}

function collect(node: LayoutNode, workspaceId: string, out: SurfaceRef[]): void {
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
        workspaceId,
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
  const byWorkspace = useLayoutStore((s) => s.byWorkspace)

  const surfaces = useMemo(() => {
    const out: SurfaceRef[] = []
    for (const [workspaceId, layout] of Object.entries(byWorkspace)) {
      if (layout) collect(layout.root, workspaceId, out)
    }
    return out
  }, [byWorkspace])

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
            <BrowserView workspaceId={s.workspaceId} paneId={s.paneId} url={s.url} />
          ) : s.kind === 'extension' && s.extensionId ? (
            <ExtensionPanelView extId={s.extensionId} workspaceId={s.workspaceId} />
          ) : (
            <TerminalView workspaceId={s.workspaceId} paneId={s.paneId} cwd={s.cwd} />
          ),
          surfaceHost(s.paneId),
          s.paneId,
        ),
      )}
    </>
  )
}
