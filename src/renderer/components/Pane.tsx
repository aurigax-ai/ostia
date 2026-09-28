import {
  Bot,
  FileCode,
  GitCompare,
  Globe,
  type LucideIcon,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Terminal,
  X,
} from 'lucide-react'
import { type DragEvent, useCallback, useEffect, useRef } from 'react'
import { commands } from '../commands/registry'
import { useDict } from '../i18n/useDict'
import type { DropZone } from '../layout/tree'
import type { PaneNode, SurfaceKind } from '../layout/types'
import { needsRing } from '../lib/attention'
import { useAttentionStore } from '../stores/attentionStore'
import { useEditorStatus } from '../stores/editorStatusStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { usePaneDnd } from '../stores/paneDndStore'
import { mountSurface, parkSurface } from '../stores/surfaceSlotsStore'
import { IconButton } from './IconButton'
import { extensionIcon } from './extensionIcons'

interface PaneProps {
  pane: PaneNode
  active: boolean
}

const SURFACE_ICON: Record<SurfaceKind, LucideIcon> = {
  terminal: Terminal,
  editor: FileCode,
  agent: Bot,
  browser: Globe,
  extension: extensionIcon(undefined),
  diff: GitCompare,
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
  const panelIcon = useExtensionsStore((s) =>
    pane.kind === 'extension'
      ? s.list.find((e) => e.id === pane.extensionId)?.panel?.icon
      : undefined,
  )
  const Icon = pane.kind === 'extension' ? extensionIcon(panelIcon) : SURFACE_ICON[pane.kind]
  const dirty = useEditorStatus((s) =>
    pane.kind === 'editor' && pane.filePath ? (s.dirty[pane.filePath] ?? false) : false,
  )
  const attention = useAttentionStore((s) => s.byPane[pane.id])
  const ring = needsRing(attention)
  const unread = attention?.unread ?? false
  const frameRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const activate = (): void => {
      if (!active) void commands.exec('pane.focus', { paneId: pane.id })
    }
    frame.addEventListener('mousedown', activate, true)
    frame.addEventListener('focusin', activate)
    return () => {
      frame.removeEventListener('mousedown', activate, true)
      frame.removeEventListener('focusin', activate)
    }
  }, [active, pane.id])
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
      className={`pane${active ? ' active' : ''}${ring ? ' attn-ring' : ''}`}
      data-attention={unread ? attention?.state : undefined}
      ref={frameRef}
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
        {unread ? (
          <span className={`pane-attn${ring ? ' loud' : ''}`}>
            <span
              className="pane-attn-mark"
              role="img"
              aria-label={ring ? d.attention.needsYou : d.attention.unread}
            />
            {attention?.message ? <span className="pane-attn-msg">{attention.message}</span> : null}
          </span>
        ) : null}
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
      pane.kind === 'diff' ||
      pane.kind === 'extension' ? (
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
