import {
  BookOpen,
  Bot,
  FileCode,
  Globe,
  Kanban,
  type LucideIcon,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Terminal,
  X,
} from 'lucide-react'
import { type DragEvent, useCallback, useRef } from 'react'
import { commands } from '../commands/registry'
import { useDict } from '../i18n/useDict'
import type { DropZone } from '../layout/tree'
import type { PaneNode, SurfaceKind } from '../layout/types'
import { useEditorStatus } from '../stores/editorStatusStore'
import { usePaneDnd } from '../stores/paneDndStore'
import { mountSurface, parkSurface } from '../stores/surfaceSlotsStore'
import { IconButton } from './IconButton'

interface PaneProps {
  pane: PaneNode
  active: boolean
}

const SURFACE_ICON: Record<SurfaceKind, LucideIcon> = {
  terminal: Terminal,
  editor: FileCode,
  agent: Bot,
  browser: Globe,
  kanban: Kanban,
  wiki: BookOpen,
}

const PANE_DND = 'application/x-pine-pane'

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

export function Pane({ pane, active }: PaneProps): JSX.Element {
  const d = useDict()
  const over = usePaneDnd((s) => (s.overId === pane.id ? s.zone : null))
  const setOver = usePaneDnd((s) => s.setOver)
  const reset = usePaneDnd((s) => s.reset)
  const Icon = SURFACE_ICON[pane.kind]
  const dirty = useEditorStatus((s) =>
    pane.kind === 'editor' && pane.filePath ? (s.dirty[pane.filePath] ?? false) : false,
  )
  const slotEl = useRef<HTMLElement | null>(null)
  const slotRef = useCallback(
    (el: HTMLElement | null) => {
      if (slotEl.current) parkSurface(pane.id, slotEl.current)
      slotEl.current = el
      if (el) mountSurface(pane.id, el)
    },
    [pane.id],
  )

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
      <div
        className="pane-header"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PANE_DND, pane.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={reset}
      >
        <Icon size={14} className="pane-kind" />
        <span className="title">
          {dirty ? '• ' : ''}
          {pane.title}
        </span>
        <div className="pane-actions">
          <IconButton
            icon={SplitSquareHorizontal}
            label={d.pane.splitRight}
            onClick={() =>
              commands.exec('pane.split', { paneId: pane.id, direction: 'horizontal' })
            }
          />
          <IconButton
            icon={SplitSquareVertical}
            label={d.pane.splitDown}
            onClick={() => commands.exec('pane.split', { paneId: pane.id, direction: 'vertical' })}
          />
          <IconButton
            icon={X}
            label={d.pane.close}
            className="hover:text-attn-fg"
            onClick={() => commands.exec('pane.close', { paneId: pane.id })}
          />
        </div>
      </div>

      {pane.kind === 'terminal' ||
      pane.kind === 'editor' ||
      pane.kind === 'browser' ||
      pane.kind === 'kanban' ||
      pane.kind === 'wiki' ? (
        <div className="pane-body pane-body-term" ref={slotRef} />
      ) : (
        <div className="pane-body">
          <span className="ghost">{pane.title}</span>
        </div>
      )}

      {over ? <span className={`pane-drop pane-drop-${over}`} /> : null}
    </div>
  )
}
