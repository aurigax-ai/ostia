import { useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { LayoutNode, SurfaceKind } from '../layout/types'
import { useLayoutStore } from '../stores/layoutStore'
import { useSurfaceSlots } from '../stores/surfaceSlotsStore'
import { BrowserView } from './BrowserView'
import { EditorView } from './Editor'
import { TerminalView } from './Terminal'

interface SurfaceRef {
  paneId: string
  sessionId: string
  kind: SurfaceKind
  cwd?: string
  filePath?: string
  url?: string
}

/** Collect every terminal/editor/browser pane across a session's layout tree. */
function collect(node: LayoutNode, sessionId: string, out: SurfaceRef[]): void {
  if (node.type === 'pane') {
    if (node.kind === 'terminal' || node.kind === 'editor' || node.kind === 'browser') {
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

/**
 * The surface pool. Renders one long-lived xterm/Monaco/webview per terminal/editor/browser
 * pane (across ALL mounted sessions) and portals it into the DOM slot Pane registers for that
 * pane id. Because the surface lives here — not in the layout tree — splitting/moving/
 * rearranging a pane only re-parents its DOM; it never remounts (so no re-attach/replay/refit
 * staircase).
 */
export function SurfacePool(): JSX.Element {
  const bySession = useLayoutStore((s) => s.bySession)
  const slots = useSurfaceSlots((s) => s.slots)

  // A persistent DETACHED node. During a split/relocate, a pane's slot unmounts one tick
  // before its replacement mounts (Allotment remounts async), so `slots[id]` is briefly
  // null. Parking the surface here (instead of unmounting it) keeps the xterm/Monaco + pty
  // alive across that window — so the surface never re-attaches/replays (no prompt staircase).
  const holderRef = useRef<HTMLDivElement | null>(null)
  if (!holderRef.current) holderRef.current = document.createElement('div')

  const surfaces = useMemo(() => {
    const out: SurfaceRef[] = []
    for (const [sessionId, layout] of Object.entries(bySession)) {
      if (layout) collect(layout.root, sessionId, out)
    }
    return out
  }, [bySession])

  return (
    <>
      {surfaces.map((s) => {
        // Portal into the pane's live slot, or park in the detached holder while it remounts.
        // The surface stays mounted either way — only its DOM parent changes.
        const container = slots[s.paneId] ?? holderRef.current
        if (!container) return null
        return createPortal(
          s.kind === 'editor' ? (
            <EditorView filePath={s.filePath} />
          ) : s.kind === 'browser' ? (
            <BrowserView url={s.url} />
          ) : (
            <TerminalView sessionId={s.sessionId} paneId={s.paneId} cwd={s.cwd} />
          ),
          container,
          s.paneId, // stable key → the surface survives layout changes without remounting
        )
      })}
    </>
  )
}
