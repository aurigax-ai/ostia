import {
  Bot,
  FileCode,
  Globe,
  type LucideIcon,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Terminal,
  X,
} from 'lucide-react'
import type { DragEvent } from 'react'
import { commands } from '../commands/registry'
import { useDict } from '../i18n/useDict'
import type { DropZone } from '../layout/tree'
import type { PaneNode, SurfaceKind } from '../layout/types'
import { usePaneDnd } from '../stores/paneDndStore'
import { useSurfaceSlots } from '../stores/surfaceSlotsStore'
import { Hint } from './Hint'

interface PaneProps {
  pane: PaneNode
  /** Whether this pane is the focused one (drives the accent ring). */
  active: boolean
}

const SURFACE_ICON: Record<SurfaceKind, LucideIcon> = {
  terminal: Terminal,
  editor: FileCode,
  agent: Bot,
  browser: Globe,
}

/** MIME-ish key so only pane drags (not files/text) trigger our drop zones. */
const PANE_DND = 'application/x-pine-pane'

/** Which edge/center the cursor is over, as fractions of the pane rect. */
function zoneFromEvent(e: DragEvent<HTMLElement>): DropZone {
  const r = e.currentTarget.getBoundingClientRect()
  const fx = (e.clientX - r.left) / r.width
  const fy = (e.clientY - r.top) / r.height
  const dist: Record<DropZone, number> = {
    left: fx,
    right: 1 - fx,
    top: fy,
    bottom: 1 - fy,
    center: 1,
  }
  let side: DropZone = 'left'
  for (const z of ['right', 'top', 'bottom'] as const) {
    if (dist[z] < dist[side]) side = z
  }
  return dist[side] < 0.25 ? side : 'center'
}

/**
 * A leaf pane (Warp-style): a header (kind icon · title · actions) over the surface
 * body. The header is the drag handle — drop on another pane's edge to relocate,
 * drop outside the window to tear off.
 */
export function Pane({ pane, active }: PaneProps): JSX.Element {
  const d = useDict()
  const over = usePaneDnd((s) => (s.overId === pane.id ? s.zone : null))
  const setOver = usePaneDnd((s) => s.setOver)
  const reset = usePaneDnd((s) => s.reset)
  const Icon = SURFACE_ICON[pane.kind]

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes(PANE_DND)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOver(pane.id, zoneFromEvent(e))
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes(PANE_DND)) return
    e.preventDefault()
    const sourceId = e.dataTransfer.getData(PANE_DND)
    const zone = zoneFromEvent(e)
    reset()
    if (sourceId && sourceId !== pane.id) {
      commands.exec('pane.move', { sourceId, targetId: pane.id, zone })
    }
  }

  return (
    <div
      className={`pane${active ? ' active' : ''}`}
      onMouseDownCapture={() => commands.exec('pane.focus', { paneId: pane.id })}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* The header is the drag handle. Drop inside → relocate; drop outside → tear off. */}
      <div
        className="pane-header"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PANE_DND, pane.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={async () => {
          reset()
          const { detached } = await window.pine.window.tearOffPane({
            id: pane.id,
            title: pane.title,
          })
          if (detached) commands.exec('pane.remove', { paneId: pane.id })
        }}
      >
        <Icon size={13} className="pane-kind" />
        <span className="title">{pane.title}</span>
        <div className="pane-actions">
          <Hint label={d.pane.splitRight} side="bottom">
            <button
              type="button"
              className="iconbtn"
              onClick={() =>
                commands.exec('pane.split', { paneId: pane.id, direction: 'horizontal' })
              }
            >
              <SplitSquareHorizontal size={14} />
            </button>
          </Hint>
          <Hint label={d.pane.splitDown} side="bottom">
            <button
              type="button"
              className="iconbtn"
              onClick={() =>
                commands.exec('pane.split', { paneId: pane.id, direction: 'vertical' })
              }
            >
              <SplitSquareVertical size={14} />
            </button>
          </Hint>
          <Hint label={d.pane.close} side="bottom">
            <button
              type="button"
              className="iconbtn danger"
              onClick={() => commands.exec('pane.close', { paneId: pane.id })}
            >
              <X size={14} />
            </button>
          </Hint>
        </div>
      </div>

      {pane.kind === 'terminal' || pane.kind === 'editor' ? (
        // Empty slot — <SurfacePool> portals the long-lived xterm/Monaco in here (keyed by
        // pane id), so a split/relocate re-parents the surface instead of remounting it.
        <div
          className="pane-body pane-body-term"
          ref={(el) => useSurfaceSlots.getState().setSlot(pane.id, el)}
        />
      ) : (
        <div className="pane-body">
          <span className="ghost">{pane.title}</span>
        </div>
      )}

      {over ? <span className={`pane-drop pane-drop-${over}`} /> : null}
    </div>
  )
}
