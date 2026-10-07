import type { AgentResume } from '@shared/agentResume'
import type { BrowserProfile } from '@shared/browserProfile'
import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { allPanes, paneBrowserProfile } from '../layout/tree'
import type { LayoutNode, SurfaceKind } from '../layout/types'
import { countUsage } from '../lib/usageCounts'
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
import { SurfaceErrorBoundary } from './SurfaceErrorBoundary'
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
  browserProfile: BrowserProfile
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
        cwd: pane.spawnDir ?? pane.cwd,
        filePath: pane.filePath,
        url: pane.url,
        extensionId: pane.extensionId,
        chatSessionId: pane.chatSessionId,
        viewName: pane.viewName,
        browserProfile: paneBrowserProfile(pane),
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

  const seen = useRef(new Set<string>())
  useEffect(() => {
    const live = new Set(surfaces.map((s) => s.paneId))
    releaseSurfaces(live)
    useDiffStore.getState().retain(live)
    for (const s of surfaces) {
      if (seen.current.has(s.paneId)) continue
      seen.current.add(s.paneId)
      countUsage('surface', s.kind)
    }
    for (const paneId of seen.current) if (!live.has(paneId)) seen.current.delete(paneId)
  }, [surfaces])

  return (
    <>
      {surfaces.map((s) =>
        createPortal(
          <SurfaceErrorBoundary paneId={s.paneId}>
            <Surface surface={s} generation={generation[s.paneId] ?? 0} />
          </SurfaceErrorBoundary>,
          surfaceHost(s.paneId),
          s.paneId,
        ),
      )}
    </>
  )
}

function Surface({
  surface: s,
  generation,
}: { surface: SurfaceRef; generation: number }): JSX.Element {
  return s.kind === 'editor' ? (
    <FileView workspaceId={s.workspaceId} paneId={s.paneId} filePath={s.filePath} />
  ) : s.kind === 'diff' ? (
    <DiffView paneId={s.paneId} />
  ) : s.kind === 'chat' ? (
    <ChatPane workspaceId={s.workspaceId} paneId={s.paneId} sessionId={s.chatSessionId} />
  ) : s.kind === 'manager' ? (
    <ManagerView paneId={s.paneId} />
  ) : s.kind === 'browser' ? (
    <BrowserView
      workspaceId={s.workspaceId}
      paneId={s.paneId}
      url={s.url}
      profile={s.browserProfile}
    />
  ) : s.kind === 'extension' && s.extensionId ? (
    <ExtensionPanelView extId={s.extensionId} workspaceId={s.workspaceId} paneId={s.paneId} />
  ) : s.kind === 'view' && s.viewName ? (
    <ViewSurface workspaceId={s.workspaceId} paneId={s.paneId} viewName={s.viewName} />
  ) : s.hibernated ? (
    <HibernatedView paneId={s.paneId} resume={s.resume} />
  ) : (
    <TerminalView key={generation} workspaceId={s.workspaceId} paneId={s.paneId} cwd={s.cwd} />
  )
}
