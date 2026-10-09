import { commands } from '@/commands/registry'
import { AgentSessionButton } from '@/components/agents/AgentSessionButton'
import { ApprovalCard } from '@/components/agents/ApprovalCard'
import { QuestionNotice } from '@/components/agents/QuestionNotice'
import { IconButton } from '@/components/common/IconButton'
import { PaneChips } from '@/components/extensions/ExtensionChips'
import { HostPaneBadge, SandboxRestartButton } from '@/components/sandbox/SandboxRestartButton'
import { useDict } from '@/i18n/useDict'
import { allPanes, findPane, firstPaneId } from '@/layout/tree'
import type { PaneNode, SurfaceKind, TabNode } from '@/layout/types'
import { leavePane } from '@/lib/attention/pointerView'
import { viewPointedPane } from '@/lib/attention/workspaceActivity'
import { type TabDrop, dropZoneAt, paneDropTarget, tabDropTarget } from '@/lib/panes/dropZone'
import {
  PANE_DND,
  beginPaneDrag,
  dropPaneOn,
  endPaneDrag,
  isPaneDrag,
  reportForeignDrop,
} from '@/lib/panes/paneDrag'
import { HOVER_FOCUS_DELAY_MS, canFocusOnHover } from '@/lib/terminal/hoverFocus'
import { cn } from '@/lib/utils'
import { useApprovalsStore } from '@/stores/agents/approvalsStore'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useQuestionsStore } from '@/stores/agents/questionsStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { usePaneDnd } from '@/stores/workspaces/paneDndStore'
import { focusSurface } from '@/stores/workspaces/surfaceSlotsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import {
  GlobeIcon,
  LockSimpleIcon,
  SquareSplitHorizontalIcon,
  SquareSplitVerticalIcon,
  TerminalWindowIcon,
  XIcon,
} from '@phosphor-icons/react'
import { type DragEvent, useEffect, useRef } from 'react'
import { PaneHeaderActions, PaneTabMenu } from './PaneTabMenu'
import { ResumeFolderNotice } from './ResumeFolderNotice'
import { SplitTabBody, SplitTabPill } from './SplitTab'
import { TabBody } from './TabBody'
import { TabFace, usePaneMark } from './TabFace'
import { TabHint } from './TabHint'
import { TabRow } from './TabRow'

interface PaneProps {
  tabs: TabNode[]
  shownId: string
  activePaneId: string
  workspaceId: string
  split?: boolean
}

const SERVICE_SURFACES: ReadonlySet<SurfaceKind> = new Set(['extension', 'chat', 'git', 'view'])

function holds(tab: TabNode, paneId: string): boolean {
  return tab.type === 'pane' ? tab.id === paneId : findPane(tab, paneId) !== null
}

function cellOf(target: EventTarget | null): string | undefined {
  return target instanceof Element
    ? target.closest<HTMLElement>('[data-cell-id]')?.dataset.cellId
    : undefined
}

export function Pane({
  tabs,
  shownId,
  activePaneId,
  workspaceId,
  split = false,
}: PaneProps): JSX.Element {
  const d = useDict()
  const shownTab = tabs.find((t) => holds(t, shownId)) ?? tabs[0]
  const shown =
    shownTab.type === 'pane' ? shownTab : (findPane(shownTab, shownId) ?? allPanes(shownTab)[0])
  const active = holds(shownTab, activePaneId)
  const dragging = usePaneDnd((s) => s.dragging)
  const over = usePaneDnd((s) => (s.overId === shown.id ? s.zone : null))
  const tabDrop = usePaneDnd((s) => (s.overId === shown.id ? s.tab : null))
  const attention = useAttentionStore((s) => s.byPane[shown.id])
  const approval = useApprovalsStore((s) => s.pending.find((r) => r.paneId === shown.id))
  const question = useQuestionsStore((s) => s.pending.find((q) => q.paneId === shown.id))
  const unread = attention?.unread ?? false
  const frameRef = useRef<HTMLDivElement>(null)
  const dimInactive = useSettingsStore((s) => s.panes.dimInactive)
  const focusOnHover = useSettingsStore((s) => s.panes.focusOnHover)
  const hideTabClose = useSettingsStore((s) => s.panes.hideTabClose)
  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !focusOnHover) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let armedFor: string | null = null
    const cancel = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      armedFor = null
    }
    const arm = (e: MouseEvent): void => {
      const target = cellOf(e.target) ?? shown.id
      if (e.buttons !== 0 || target === activePaneId) {
        cancel()
        return
      }
      if (armedFor === target) return
      cancel()
      armedFor = target
      timer = setTimeout(() => {
        timer = null
        armedFor = null
        if (!canFocusOnHover(document)) return
        void commands.exec('pane.focus', { paneId: target })
        requestAnimationFrame(() => focusSurface(target))
      }, HOVER_FOCUS_DELAY_MS)
    }
    frame.addEventListener('mouseenter', arm)
    frame.addEventListener('mousemove', arm)
    frame.addEventListener('mouseleave', cancel)
    frame.addEventListener('mousedown', cancel, true)
    return () => {
      cancel()
      frame.removeEventListener('mouseenter', arm)
      frame.removeEventListener('mousemove', arm)
      frame.removeEventListener('mouseleave', cancel)
      frame.removeEventListener('mousedown', cancel, true)
    }
  }, [focusOnHover, activePaneId, shown.id])
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    let pointed = shown.id
    const point = (e: MouseEvent): void => {
      const target = cellOf(e.target) ?? shown.id
      if (target !== pointed) leavePane(pointed)
      pointed = target
      viewPointedPane(target)
    }
    const leave = (): void => leavePane(pointed)
    frame.addEventListener('mouseenter', point)
    frame.addEventListener('mousemove', point)
    frame.addEventListener('mouseleave', leave)
    return () => {
      leave()
      frame.removeEventListener('mouseenter', point)
      frame.removeEventListener('mousemove', point)
      frame.removeEventListener('mouseleave', leave)
    }
  }, [shown.id])
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const activate = (e: Event): void => {
      const target = cellOf(e.target) ?? shown.id
      if (target !== activePaneId) void commands.exec('pane.focus', { paneId: target })
    }
    frame.addEventListener('mousedown', activate, true)
    frame.addEventListener('focusin', activate)
    return () => {
      frame.removeEventListener('mousedown', activate, true)
      frame.removeEventListener('focusin', activate)
    }
  }, [activePaneId, shown.id])

  const tabIds = tabs.map((t) => t.id)
  const slot = { tabIds, shownId: shown.id }
  const tabFocus = (id: string): string => {
    const tab = tabs.find((t) => t.id === id)
    return tab ? firstPaneId(tab) : id
  }

  const zoneAt = (e: DragEvent<HTMLElement>) => {
    const rect = frameRef.current?.getBoundingClientRect()
    return rect ? dropZoneAt(rect, e.clientX, e.clientY) : 'center'
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
    dropPaneOn(sourceId, tabFocus(target.targetId), target.zone)
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
    reportForeignDrop(sourceId, { paneId: tabFocus(target.targetId), zone: 'center' })
  }

  return (
    <div
      className={`pane${active ? ' active' : ''}${split && !active && dimInactive ? ' dimmed' : ''}`}
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
        <TabRow
          tabs={tabs}
          shownTabId={shownTab.id}
          label={d.pane.tabs}
          onNewTab={() => void commands.exec('tab.new', { paneId: shown.id })}
        >
          {tabs.map((tab) => {
            const dropMark =
              tabDrop?.targetId === tab.id ? (tabDrop.after ? 'after' : 'before') : null
            return tab.type === 'pane' ? (
              <PaneTab
                key={tab.id}
                pane={tab}
                selected={tab === shownTab}
                dropMark={dropMark}
                showClose={!hideTabClose}
              />
            ) : (
              <SplitTabPill
                key={tab.id}
                tab={tab}
                selected={tab === shownTab}
                focusedId={shown.id}
                dropMark={dropMark}
                showClose={!hideTabClose}
                workspaceId={workspaceId}
              />
            )
          })}
        </TabRow>
        {unread && attention?.message ? (
          <span className="pane-attn">
            <span className="pane-attn-msg">{attention.message}</span>
          </span>
        ) : null}
        <PaneChips paneId={shown.id} />
        <SandboxRestartButton pane={shown} />
        <HostPaneBadge pane={shown} />
        <div className="pane-actions">
          <AgentSessionButton pane={shown} />
          <PaneHeaderActions pane={shown} />
          {SERVICE_SURFACES.has(shown.kind) ? null : (
            <>
              <IconButton
                icon={TerminalWindowIcon}
                label={d.pane.newTab}
                command="tab.new"
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
                command="pane.splitRight"
                onClick={() =>
                  commands.exec('pane.split', { paneId: shown.id, direction: 'horizontal' })
                }
              />
              <IconButton
                icon={SquareSplitVerticalIcon}
                label={d.pane.splitDown}
                command="pane.splitDown"
                onClick={() =>
                  commands.exec('pane.split', { paneId: shown.id, direction: 'vertical' })
                }
              />
            </>
          )}
        </div>
      </div>

      <div className="pane-body pane-body-term">
        {tabs.map((tab) =>
          tab.type === 'pane' ? (
            <TabBody key={tab.id} pane={tab} shown={tab === shownTab} />
          ) : (
            <SplitTabBody
              key={tab.id}
              tab={tab}
              workspaceId={workspaceId}
              shown={tab === shownTab}
              focusedId={shown.id}
              frameActive={active}
              stackTabIds={tabIds}
            />
          ),
        )}
        {shownTab.type !== 'pane' ? null : approval ? (
          <ApprovalCard request={approval} paneTitle={shown.title} />
        ) : question ? (
          <QuestionNotice question={question} />
        ) : shown.resumeFolderMissing && shown.resume ? (
          <ResumeFolderNotice
            paneId={shown.id}
            resume={shown.resume}
            folder={shown.resumeFolderMissing}
          />
        ) : null}
      </div>

      {shown.kind === 'terminal' ? null : <div className="pane-file-drop" />}
      {dragging && shownTab.type === 'pane' ? (
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
  const mark = usePaneMark(pane)
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)

  const tab = (
    <div
      className={cn(
        'pane-tab',
        selected && 'selected',
        pane.locked && 'locked',
        dropMark && `drop-${dropMark}`,
      )}
      data-attention={mark ?? undefined}
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
      <TabHint pane={pane}>
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
          <TabFace pane={pane} />
        </button>
      </TabHint>
      {pane.locked ? (
        <IconButton
          icon={LockSimpleIcon}
          label={d.pane.unlock}
          className="pane-tab-lock"
          onClick={() => commands.exec('pane.toggleLock', { paneId: pane.id })}
        />
      ) : showClose ? (
        <IconButton
          icon={XIcon}
          label={d.pane.closeTab}
          command="pane.close"
          className="pane-tab-close hover:text-attn-fg"
          onClick={() => commands.exec('pane.close', { paneId: pane.id })}
        />
      ) : null}
    </div>
  )
  return <PaneTabMenu pane={pane} workspaceId={workspaceId} trigger={tab} />
}
