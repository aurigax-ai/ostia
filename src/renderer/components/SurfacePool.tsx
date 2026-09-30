import type { AgentResume } from '@shared/agentResume'
import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { allPanes } from '../layout/tree'
import type { LayoutNode, SurfaceKind } from '../layout/types'
import { useDiffStore } from '../stores/diffStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSandboxStore } from '../stores/sandboxStore'
import { releaseSurfaces, surfaceHost } from '../stores/surfaceSlotsStore'
import { BrowserView } from './BrowserView'
import { ChatPane } from './ChatPane'
import { DiffView } from './DiffView'
import { ExtensionPanelView } from './ExtensionPanelView'
import { FileView } from './FileView'
import { HibernatedView } from './HibernatedView'
import { ManagerView } from './ManagerView'
import { TerminalView } from './Terminal'
import { ViewSurface } from './ViewSurface'

interface SurfaceRef {
  paneId: string
  workspaceId: string
  kind: SurfaceKind
  cwd?: string
  filePath?: string
  url?: string
  extensionId?: string
  chatSessionId?: string
  viewName?: string
  hibernated?: true
  resume?: AgentResume
}

function collect(node: LayoutNode, workspaceId: string, out: SurfaceRef[]): void {
  for (const pane of allPanes(node)) {
    if (
      pane.kind === 'terminal' ||
      pane.kind === 'editor' ||
      pane.kind === 'browser' ||
      pane.kind === 'diff' ||
      pane.kind === 'chat' ||
      pane.kind === 'manager' ||
      (pane.kind === 'extension' && pane.extensionId) ||
      (pane.kind === 'view' && pane.viewName)
    ) {
      out.push({
        paneId: pane.id,
        workspaceId,
        kind: pane.kind,
        cwd: pane.cwd,
        filePath: pane.filePath,
        url: pane.url,
        extensionId: pane.extensionId,
        chatSessionId: pane.chatSessionId,
        viewName: pane.viewName,
        hibernated: pane.hibernated,
        resume: pane.resume,
      })
    }
  }
}

export function SurfacePool(): JSX.Element {
  const byWorkspace = useLayoutStore((s) => s.byWorkspace)
  const generation = useSandboxStore((s) => s.generation)

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
            <FileView workspaceId={s.workspaceId} paneId={s.paneId} filePath={s.filePath} />
          ) : s.kind === 'diff' ? (
            <DiffView paneId={s.paneId} />
          ) : s.kind === 'chat' ? (
            <ChatPane workspaceId={s.workspaceId} paneId={s.paneId} sessionId={s.chatSessionId} />
          ) : s.kind === 'manager' ? (
            <ManagerView paneId={s.paneId} />
          ) : s.kind === 'browser' ? (
            <BrowserView workspaceId={s.workspaceId} paneId={s.paneId} url={s.url} />
          ) : s.kind === 'extension' && s.extensionId ? (
            <ExtensionPanelView
              extId={s.extensionId}
              workspaceId={s.workspaceId}
              paneId={s.paneId}
            />
          ) : s.kind === 'view' && s.viewName ? (
            <ViewSurface workspaceId={s.workspaceId} paneId={s.paneId} viewName={s.viewName} />
          ) : s.hibernated ? (
            <HibernatedView paneId={s.paneId} resume={s.resume} />
          ) : (
            <TerminalView
              key={generation[s.paneId] ?? 0}
              workspaceId={s.workspaceId}
              paneId={s.paneId}
              cwd={s.cwd}
            />
          ),
          surfaceHost(s.paneId),
          s.paneId,
        ),
      )}
    </>
  )
}
