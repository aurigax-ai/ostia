import {
  FileCodeIcon,
  GitDiffIcon,
  GlobeIcon,
  type Icon as IconComponent,
  PlayIcon,
  PlusIcon,
  RobotIcon,
  SquareSplitHorizontalIcon,
  SquareSplitVerticalIcon,
  TerminalWindowIcon,
  XIcon,
} from '@phosphor-icons/react'
import { resumeCommand } from '@shared/agentResume'
import { type DragEvent, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { commands } from '../commands/registry'
import { fmt, useDict } from '../i18n/useDict'
import type { DropZone } from '../layout/tree'
import type { PaneNode, SurfaceKind } from '../layout/types'
import { needsRing } from '../lib/attention'
import { isIdlePrompt } from '../lib/blocks'
import { chordLabel } from '../lib/chords'
import { isMac } from '../platform'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useEditorStatus } from '../stores/editorStatusStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { usePaneDnd } from '../stores/paneDndStore'
import { focusSurface, mountSurface, parkSurface } from '../stores/surfaceSlotsStore'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { extensionIcon } from './extensionIcons'
import { Button } from './ui/button'

interface PaneProps {
  tabs: PaneNode[]
  shownId: string
  active: boolean
  split?: boolean
}

const SURFACE_ICON: Record<SurfaceKind, IconComponent> = {
  terminal: TerminalWindowIcon,
  editor: FileCodeIcon,
  agent: RobotIcon,
  browser: GlobeIcon,
  extension: extensionIcon(undefined),
  diff: GitDiffIcon,
}

const PANE_DND = 'application/x-pine-pane'

const RESUME_KEYS = chordLabel('agent.resume', isMac)

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

function hasSurface(kind: SurfaceKind): boolean {
  return kind !== 'agent'
}

export function Pane({ tabs, shownId, active, split = false }: PaneProps): JSX.Element {
  const d = useDict()
  const shown = tabs.find((t) => t.id === shownId) ?? tabs[0]
  const over = usePaneDnd((s) => (s.overId === shown.id ? s.zone : null))
  const setOver = usePaneDnd((s) => s.setOver)
  const reset = usePaneDnd((s) => s.reset)
  const attention = useAttentionStore((s) => s.byPane[shown.id])
  const ring = needsRing(attention)
  const unread = attention?.unread ?? false
  const frameRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const activate = (): void => {
      if (!active) void commands.exec('pane.focus', { paneId: shown.id })
    }
    frame.addEventListener('mousedown', activate, true)
    frame.addEventListener('focusin', activate)
    return () => {
      frame.removeEventListener('mousedown', activate, true)
      frame.removeEventListener('focusin', activate)
    }
  }, [active, shown.id])

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes(PANE_DND)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOver(shown.id, zoneFromEvent(e))
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes(PANE_DND)) return
    e.preventDefault()
    const sourceId = e.dataTransfer.getData(PANE_DND)
    const zone = zoneFromEvent(e)
    reset()
    if (sourceId && sourceId !== shown.id) {
      commands.exec('pane.move', { sourceId, targetId: shown.id, zone })
    }
  }

  return (
    <div
      className={`pane${active ? ' active' : ''}${split && !active ? ' dimmed' : ''}${ring ? ' attn-ring' : ''}`}
      data-attention={unread ? attention?.state : undefined}
      ref={frameRef}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="pane-header">
        <div className="pane-tabs" role="tablist" aria-label={d.pane.tabs}>
          {tabs.map((tab) => (
            <PaneTab key={tab.id} pane={tab} selected={tab.id === shown.id} onDragEnd={reset} />
          ))}
        </div>
        {unread && attention?.message ? (
          <span className="pane-attn">
            <span className="pane-attn-msg">{attention.message}</span>
          </span>
        ) : null}
        <ResumeButton pane={shown} />
        <div className="pane-actions">
          <IconButton
            icon={PlusIcon}
            label={d.pane.newTab}
            onClick={() => commands.exec('tab.new', { paneId: shown.id })}
          />
          <IconButton
            icon={GlobeIcon}
            label={d.pane.newBrowserTab}
            onClick={() => commands.exec('tab.newBrowser', { paneId: shown.id })}
          />
          <IconButton
            icon={SquareSplitHorizontalIcon}
            label={d.pane.splitRight}
            onClick={() =>
              commands.exec('pane.split', { paneId: shown.id, direction: 'horizontal' })
            }
          />
          <IconButton
            icon={SquareSplitVerticalIcon}
            label={d.pane.splitDown}
            onClick={() => commands.exec('pane.split', { paneId: shown.id, direction: 'vertical' })}
          />
        </div>
      </div>

      <div className="pane-body pane-body-term">
        {tabs.map((tab) => (
          <TabBody key={tab.id} pane={tab} shown={tab.id === shown.id} />
        ))}
      </div>

      {ring ? (
        <span className="pane-attn-ring" aria-hidden="true">
          <span key={attention?.at} className="pane-attn-pulse" />
        </span>
      ) : null}
      {over ? <span className={`pane-drop pane-drop-${over}`} /> : null}
    </div>
  )
}

function ResumeButton({ pane }: { pane: PaneNode }): JSX.Element | null {
  const d = useDict()
  const idle = useBlocksStore((s) => isIdlePrompt(s, pane.id))
  if (pane.kind !== 'terminal' || !pane.resume || !idle) return null
  const label = fmt(d.pane.resume, { agent: pane.resume.agent })
  return (
    <Hint label={`${resumeCommand(pane.resume)}  ${RESUME_KEYS}`}>
      <Button variant="outline" size="xs" onClick={() => void commands.exec('agent.resume')}>
        <PlayIcon data-icon="inline-start" aria-hidden />
        {label}
      </Button>
    </Hint>
  )
}

function PaneTab({
  pane,
  selected,
  onDragEnd,
}: {
  pane: PaneNode
  selected: boolean
  onDragEnd: () => void
}): JSX.Element {
  const d = useDict()
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
  const unread = attention?.unread ?? false
  const ring = needsRing(attention)

  return (
    <div
      className={`pane-tab${selected ? ' selected' : ''}`}
      data-attention={unread ? attention?.state : undefined}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PANE_DND, pane.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        className="pane-tab-main"
        onClick={() => {
          void commands.exec('pane.focus', { paneId: pane.id })
          requestAnimationFrame(() => focusSurface(pane.id))
        }}
      >
        <Icon size={14} className="pane-kind" />
        <span className="title">
          {dirty ? '• ' : ''}
          {pane.title}
        </span>
        {unread ? (
          <span
            className={`pane-attn-mark${ring ? ' loud' : ''}`}
            role="img"
            aria-label={ring ? d.attention.needsYou : d.attention.unread}
          />
        ) : null}
      </button>
      <IconButton
        icon={XIcon}
        label={d.pane.closeTab}
        className="pane-tab-close hover:text-attn-fg"
        onClick={() => commands.exec('pane.close', { paneId: pane.id })}
      />
    </div>
  )
}

function TabBody({ pane, shown }: { pane: PaneNode; shown: boolean }): JSX.Element | null {
  const slotEl = useRef<HTMLDivElement | null>(null)
  const slotRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (slotEl.current) parkSurface(pane.id, slotEl.current)
      slotEl.current = el
      if (el) mountSurface(pane.id, el)
    },
    [pane.id],
  )
  useLayoutEffect(() => {
    if (slotEl.current) slotEl.current.inert = !shown
  }, [shown])

  if (!hasSurface(pane.kind)) {
    return shown ? (
      <div className="pane-slot pane-slot-ghost">
        <span className="ghost">{pane.title}</span>
      </div>
    ) : null
  }
  return <div className="pane-slot" data-hidden={shown ? undefined : ''} ref={slotRef} />
}
