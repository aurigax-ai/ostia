import { cn } from '@/lib/utils'
import {
  BroadcastIcon,
  ChatCircleTextIcon,
  FileCodeIcon,
  GitDiffIcon,
  GlobeIcon,
  type Icon as IconComponent,
  MoonIcon,
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
import type { DropZone, PaneNode, SurfaceKind } from '../layout/types'
import { needsRing } from '../lib/attention'
import { isIdlePrompt } from '../lib/blocks'
import { useChordLabel } from '../lib/chords'
import { type TabDrop, dropZoneAt, paneDropTarget, tabDropTarget } from '../lib/dropZone'
import { HOVER_FOCUS_DELAY_MS, canFocusOnHover } from '../lib/hoverFocus'
import {
  PANE_DND,
  beginPaneDrag,
  endPaneDrag,
  isPaneDrag,
  reportForeignDrop,
} from '../lib/paneDrag'
import { isMac } from '../platform'
import { useApprovalsStore } from '../stores/approvalsStore'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useEditorStatus } from '../stores/editorStatusStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { usePaneDnd } from '../stores/paneDndStore'
import { useSettingsStore } from '../stores/settingsStore'
import { focusSurface, mountSurface, parkSurface } from '../stores/surfaceSlotsStore'
import { useViewsStore } from '../stores/viewsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { AgentSessionButton } from './AgentSessionButton'
import { ApprovalCard } from './ApprovalCard'
import { PaneChips } from './ExtensionChips'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { PaneHeaderActions, PaneTabMenu } from './PaneTabMenu'
import { HostPaneBadge, SandboxRestartButton } from './SandboxRestartButton'
import { extensionIcon } from './extensionIcons'
import { Button } from './ui/button'
import { viewIcon } from './viewIcons'

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
  chat: ChatCircleTextIcon,
  view: viewIcon(undefined),
  manager: BroadcastIcon,
}

function hasSurface(kind: SurfaceKind): boolean {
  return kind !== 'agent'
}

export function Pane({ tabs, shownId, active, split = false }: PaneProps): JSX.Element {
  const d = useDict()
  const shown = tabs.find((t) => t.id === shownId) ?? tabs[0]
  const dragging = usePaneDnd((s) => s.dragging)
  const over = usePaneDnd((s) => (s.overId === shown.id ? s.zone : null))
  const tabDrop = usePaneDnd((s) => (s.overId === shown.id ? s.tab : null))
  const attention = useAttentionStore((s) => s.byPane[shown.id])
  const approval = useApprovalsStore((s) => s.pending.find((r) => r.paneId === shown.id))
  const ring = needsRing(attention)
  const unread = attention?.unread ?? false
  const frameRef = useRef<HTMLDivElement>(null)
  const dimInactive = useSettingsStore((s) => s.panes.dimInactive)
  const focusOnHover = useSettingsStore((s) => s.panes.focusOnHover)
  const hideTabClose = useSettingsStore((s) => s.panes.hideTabClose)
  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !focusOnHover || active) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const cancel = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const arm = (e: MouseEvent): void => {
      cancel()
      if (e.buttons !== 0) return
      timer = setTimeout(() => {
        timer = null
        if (!canFocusOnHover(document)) return
        void commands.exec('pane.focus', { paneId: shown.id })
        requestAnimationFrame(() => focusSurface(shown.id))
      }, HOVER_FOCUS_DELAY_MS)
    }
    frame.addEventListener('mouseenter', arm)
    frame.addEventListener('mouseleave', cancel)
    frame.addEventListener('mousedown', cancel, true)
    return () => {
      cancel()
      frame.removeEventListener('mouseenter', arm)
      frame.removeEventListener('mouseleave', cancel)
      frame.removeEventListener('mousedown', cancel, true)
    }
  }, [focusOnHover, active, shown.id])
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

  const tabIds = tabs.map((t) => t.id)
  const slot = { tabIds, shownId: shown.id }

  const zoneAt = (e: DragEvent<HTMLElement>) => {
    const rect = frameRef.current?.getBoundingClientRect()
    return rect ? dropZoneAt(rect, e.clientX, e.clientY) : 'center'
  }

  const dropPaneHere = (sourceId: string, targetId: string, zone: DropZone): void => {
    const dnd = usePaneDnd.getState()
    dnd.dropped()
    if (dnd.sourceId === sourceId) {
      void commands.exec('pane.move', { sourceId, targetId, zone })
      return
    }
    reportForeignDrop(sourceId, { paneId: targetId, zone })
  }

  const onLayerDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!isPaneDrag([...e.dataTransfer.types])) return
    e.preventDefault()
    const zone = zoneAt(e)
    if (!paneDropTarget(slot, usePaneDnd.getState().sourceId, zone)) {
      e.dataTransfer.dropEffect = 'none'
      usePaneDnd.getState().leave(shown.id)
      return
    }
    e.dataTransfer.dropEffect = 'move'
    usePaneDnd.getState().setOver(shown.id, zone)
  }

  const onLayerDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!isPaneDrag([...e.dataTransfer.types])) return
    e.preventDefault()
    const sourceId = e.dataTransfer.getData(PANE_DND)
    const zone = zoneAt(e)
    const target = sourceId ? paneDropTarget(slot, sourceId, zone) : null
    if (!target) {
      usePaneDnd.getState().dropped()
      return
    }
    dropPaneHere(sourceId, target.targetId, target.zone)
  }

  const hoveredTab = (e: DragEvent<HTMLElement>): TabDrop | null => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab-id]')
    const targetId = tab?.dataset.tabId
    if (!tab || !targetId) return null
    const rect = tab.getBoundingClientRect()
    return { targetId, after: e.clientX > rect.left + rect.width / 2 }
  }

  const onHeaderDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!isPaneDrag([...e.dataTransfer.types])) return
    const target = tabDropTarget(tabIds, usePaneDnd.getState().sourceId, hoveredTab(e))
    if (!target) {
      usePaneDnd.getState().leave(shown.id)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    usePaneDnd.getState().setOver(shown.id, 'center', target)
  }

  const onHeaderDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!isPaneDrag([...e.dataTransfer.types])) return
    e.preventDefault()
    const sourceId = e.dataTransfer.getData(PANE_DND)
    const local = usePaneDnd.getState().sourceId === sourceId
    const target = sourceId ? tabDropTarget(tabIds, local ? sourceId : null, hoveredTab(e)) : null
    usePaneDnd.getState().dropped()
    if (!target) return
    if (local) {
      void commands.exec('pane.moveTab', {
        sourceId,
        targetId: target.targetId,
        after: target.after,
      })
      return
    }
    reportForeignDrop(sourceId, { paneId: target.targetId, zone: 'center' })
  }

  return (
    <div
      className={`pane${active ? ' active' : ''}${split && !active && dimInactive ? ' dimmed' : ''}${ring ? ' attn-ring' : ''}`}
      data-attention={unread ? attention?.state : undefined}
      data-pane-id={shown.id}
      ref={frameRef}
    >
      <div
        className={cn('pane-header', over === 'center' && 'drop-tab')}
        onDragOver={onHeaderDragOver}
        onDragLeave={() => usePaneDnd.getState().leave(shown.id)}
        onDrop={onHeaderDrop}
      >
        <div
          className="pane-tabs"
          role="tablist"
          aria-label={d.pane.tabs}
          onDoubleClick={(e) => {
            if (e.target === e.currentTarget) void commands.exec('tab.new', { paneId: shown.id })
          }}
        >
          {tabs.map((tab) => (
            <PaneTab
              key={tab.id}
              pane={tab}
              selected={tab.id === shown.id}
              dropMark={tabDrop?.targetId === tab.id ? (tabDrop.after ? 'after' : 'before') : null}
              showClose={!hideTabClose}
            />
          ))}
        </div>
        {unread && attention?.message ? (
          <span className="pane-attn">
            <span className="pane-attn-msg">{attention.message}</span>
          </span>
        ) : null}
        <PaneChips paneId={shown.id} />
        <ResumeButton pane={shown} />
        <SandboxRestartButton pane={shown} />
        <HostPaneBadge pane={shown} />
        <div className="pane-actions">
          <AgentSessionButton pane={shown} />
          <PaneHeaderActions pane={shown} />
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
        {approval ? <ApprovalCard request={approval} paneTitle={shown.title} /> : null}
      </div>

      {ring ? (
        <span className="pane-attn-ring" aria-hidden="true">
          <span key={attention?.at} className="pane-attn-pulse" />
        </span>
      ) : null}
      {shown.kind === 'terminal' ? null : <div className="pane-file-drop" />}
      {dragging ? (
        <div
          className="pane-drop-layer"
          onDragOver={onLayerDragOver}
          onDragLeave={() => usePaneDnd.getState().leave(shown.id)}
          onDrop={onLayerDrop}
        />
      ) : null}
      {over && !tabDrop ? <span className={`pane-drop pane-drop-${over}`} /> : null}
    </div>
  )
}

function ResumeButton({ pane }: { pane: PaneNode }): JSX.Element | null {
  const d = useDict()
  const idle = useBlocksStore((s) => isIdlePrompt(s, pane.id))
  const resumeKeys = useChordLabel('agent.resume', isMac)
  if (pane.kind !== 'terminal' || !pane.resume || !(idle || pane.hibernated)) return null
  const label = fmt(d.pane.resume, { agent: pane.resume.agent })
  return (
    <Hint label={[resumeCommand(pane.resume), resumeKeys].filter(Boolean).join('  ')}>
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
  dropMark,
  showClose,
}: {
  pane: PaneNode
  selected: boolean
  dropMark: 'before' | 'after' | null
  showClose: boolean
}): JSX.Element {
  const d = useDict()
  const panelIcon = useExtensionsStore((s) =>
    pane.kind === 'extension'
      ? s.list.find((e) => e.id === pane.extensionId)?.panel?.icon
      : undefined,
  )
  const viewIconName = useViewsStore((s) =>
    pane.kind === 'view' ? s.views.find((v) => v.name === pane.viewName)?.icon : undefined,
  )
  const Icon = pane.hibernated
    ? MoonIcon
    : pane.kind === 'extension'
      ? extensionIcon(panelIcon)
      : pane.kind === 'view'
        ? viewIcon(viewIconName)
        : SURFACE_ICON[pane.kind]
  const dirty = useEditorStatus((s) =>
    pane.kind === 'editor' && pane.filePath ? (s.dirty[pane.filePath] ?? false) : false,
  )
  const diskProblem = useEditorStatus((s) =>
    pane.kind === 'editor' && pane.filePath ? (s.disk[pane.filePath] ?? null) : null,
  )
  const diskLabel = {
    changed: d.editor.diskMarkChanged,
    conflict: d.editor.diskMarkConflict,
    deleted: d.editor.diskMarkDeleted,
  }
  const attention = useAttentionStore((s) => s.byPane[pane.id])
  const unread = attention?.unread ?? false
  const ring = needsRing(attention)
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)

  const tab = (
    <div
      className={cn('pane-tab', selected && 'selected', dropMark && `drop-${dropMark}`)}
      data-attention={unread ? attention?.state : undefined}
      data-tab-id={pane.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PANE_DND, pane.id)
        e.dataTransfer.effectAllowed = 'move'
        beginPaneDrag(pane.id, e)
      }}
      onDragEnd={(e) => endPaneDrag(workspaceId, pane.id, e)}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault()
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.preventDefault()
        void commands.exec('pane.close', { paneId: pane.id })
      }}
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
        <Icon
          size={14}
          className="pane-kind"
          aria-label={pane.hibernated ? d.pane.hibernated : undefined}
        />
        {dirty && !diskProblem ? (
          <span className="dot pane-tab-dirty" role="img" aria-label={d.pane.unsaved} />
        ) : null}
        <span className={cn('title', diskProblem === 'deleted' && 'line-through')}>
          {pane.title}
        </span>
        {diskProblem ? (
          <Hint label={diskLabel[diskProblem]}>
            <span className="pane-disk-mark" role="img" aria-label={diskLabel[diskProblem]} />
          </Hint>
        ) : null}
        {unread ? (
          <span
            className={`pane-attn-mark${ring ? ' loud' : ''}`}
            role="img"
            aria-label={ring ? d.attention.needsYou : d.attention.unread}
          />
        ) : null}
      </button>
      {showClose ? (
        <IconButton
          icon={XIcon}
          label={d.pane.closeTab}
          className="pane-tab-close hover:text-attn-fg"
          onClick={() => commands.exec('pane.close', { paneId: pane.id })}
        />
      ) : null}
    </div>
  )
  return <PaneTabMenu pane={pane} workspaceId={workspaceId} trigger={tab} />
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
