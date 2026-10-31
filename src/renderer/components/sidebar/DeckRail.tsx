import { GearSixIcon } from '@phosphor-icons/react'
import { useContext, useEffect, useState } from 'react'
import { PanelResizer } from '@/components/common/PanelResizer'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ViewsRail } from '@/components/views/ViewsRail'
import { useDict } from '@/lib/app/useDict'
import { RAIL_WIDTH } from '@/lib/panes/panelWidth'
import { useRailMotion } from '@/lib/sidebar/railMotion'
import { toBlocks } from '@/lib/sidebar/workspaceGroups'
import { moveTabToWorkspace } from '@/lib/workspaces/tabWorkspaceMove'
import { loadMergeTargets, requestMergeWorkspace } from '@/lib/workspaces/workspaceMerge'
import { useUIStore } from '@/stores/app/uiStore'
import { usePaneDnd } from '@/stores/workspaces/paneDndStore'
import { useRailDragStore } from '@/stores/workspaces/railDragStore'
import { useRailEditStore } from '@/stores/workspaces/railEditStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { GroupBlock } from './GroupBlock'
import { RailCard } from './narrow/RailCard'
import { SidebarFooter } from './RailMeta'
import { RailCollapsedContext, RailTab } from './RailTab'
import { RemoteWorkspaces } from './RemoteWorkspaces'
import { type DragHandlers, draggedTab, isRailDrag, type TabDropHandlers } from './railDrag'
import { WorkspaceRow } from './WorkspaceRow'

const RAIL_ID = 'deck-rail'

export function DeckRail(): JSX.Element {
  const d = useDict()
  const collapsed = useUIStore((s) => s.railCollapsed)
  const setRailCollapsed = useUIStore((s) => s.setRailCollapsed)
  const motion = useRailMotion(collapsed)
  return (
    <>
      <aside
        id={RAIL_ID}
        className={`deck-rail${motion.shownCollapsed ? ' collapsed' : ''}`}
        data-rail-motion={motion.phase ?? undefined}
        onAnimationEnd={motion.onAnimationEnd}
      >
        <RailCollapsedContext.Provider value={motion.shownCollapsed}>
          <WorkspacesView />
        </RailCollapsedContext.Provider>
      </aside>
      <PanelResizer
        spec={RAIL_WIDTH}
        label={d.rail.resize}
        controls={RAIL_ID}
        className="rail-resizer"
        collapsed={collapsed}
        onCollapsedChange={setRailCollapsed}
      />
    </>
  )
}

function WorkspacesView(): JSX.Element {
  const d = useDict()
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const groups = useWorkspacesStore((s) => s.groups)
  const activeId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const dragging = useRailDragStore((s) => s.source !== null)
  const target = useRailDragStore((s) => s.target)
  const mergeable = useRailDragStore((s) => s.mergeable)
  const [tabOver, setTabOver] = useState<string | null>(null)
  const paneDragging = usePaneDnd((s) => s.dragging)
  useEffect(() => {
    if (!paneDragging) setTabOver(null)
  }, [paneDragging])
  const renamingGroup = useRailEditStore((s) => (s.editing?.kind === 'group' ? s.editing.id : null))
  const setRenamingGroup = (id: string | null): void => {
    const edit = useRailEditStore.getState()
    if (id !== null) edit.begin({ kind: 'group', id })
    else if (renamingGroup !== null) edit.end({ kind: 'group', id: renamingGroup })
  }
  const settingsTabOpen = useUIStore((s) => s.settingsTabOpen)
  const settingsActive = useUIStore((s) => s.settingsActive)
  const openSettings = useUIStore((s) => s.openSettings)
  const closeSettings = useUIStore((s) => s.closeSettings)

  const railDrag = useRailDragStore.getState
  const handlers: DragHandlers = {
    start: (source) => {
      railDrag().start(source)
      if (source.kind !== 'workspace') return
      void loadMergeTargets(source.id).then((targets) => {
        const ids = targets.filter((t) => t.refusal === null).map((t) => t.id)
        railDrag().offerMerges(source, ids)
      })
    },
    over: (next) => railDrag().aim(next),
    end: () => railDrag().end(),
  }
  const dropOnRail = (): void => {
    const taken = railDrag().take()
    if (!taken) return
    if (taken.target.kind === 'merge') void requestMergeWorkspace(taken.source.id, taken.target.id)
    else useWorkspacesStore.getState().drop(taken.source, taken.target)
  }
  const tabDrop: TabDropHandlers = {
    over: (workspaceId) => setTabOver(workspaceId),
    leave: (workspaceId) => setTabOver((cur) => (cur === workspaceId ? null : cur)),
    drop: (workspaceId) => {
      setTabOver(null)
      const dragged = draggedTab()
      usePaneDnd.getState().dropped()
      if (dragged) void moveTabToWorkspace(dragged.sourceId, dragged.tabId, workspaceId)
    },
  }
  const tabTarget = paneDragging ? tabOver : null
  const collapsed = useContext(RailCollapsedContext)
  const single = (w: Workspace): JSX.Element => (
    <RailCard key={w.id} members={[w]}>
      {row(w)}
    </RailCard>
  )

  const row = (w: Workspace): JSX.Element => (
    <WorkspaceRow
      key={w.id}
      workspace={w}
      index={workspaces.indexOf(w)}
      active={!settingsActive && w.id === activeId}
      drop={
        tabTarget === w.id
          ? 'tab'
          : target?.kind === 'merge' && target.id === w.id
            ? 'merge'
            : target?.kind === 'workspace' && target.id === w.id
              ? target.place
              : null
      }
      mergeable={mergeable.has(w.id)}
      drag={handlers}
      tabDrop={tabDrop}
      onGroupCreated={setRenamingGroup}
    />
  )

  return (
    <>
      <ScrollArea className="scroll-quiet rail-scroll">
        <div
          className="workspaces"
          onDragOver={(e) => {
            if (isRailDrag(e) && railDrag().target !== null) e.preventDefault()
          }}
          onDragLeave={(e) => {
            if (!isRailDrag(e) || e.currentTarget.contains(e.relatedTarget as Node | null)) return
            railDrag().leave()
          }}
          onDrop={(e) => {
            if (!isRailDrag(e)) return
            e.preventDefault()
            dropOnRail()
          }}
        >
          {settingsTabOpen ? (
            <RailTab
              active={settingsActive}
              onSelect={() => openSettings()}
              onClose={closeSettings}
              closeLabel={d.rail.close}
              icon={<GearSixIcon size={16} className="tab-lead" />}
              title={d.topbar.settings}
            />
          ) : null}

          {toBlocks({ workspaces, groups }).map((block) =>
            block.group ? (
              <GroupBlock
                key={block.group.id}
                group={block.group}
                members={block.workspaces}
                containsActive={!settingsActive && block.workspaces.some((w) => w.id === activeId)}
                drop={
                  target?.kind === 'group' && target.id === block.group.id ? target.place : null
                }
                drag={handlers}
                renaming={renamingGroup === block.group.id}
                onRenaming={(on) => setRenamingGroup(on ? (block.group?.id ?? null) : null)}
              >
                {block.workspaces.map(row)}
              </GroupBlock>
            ) : (
              block.workspaces.map((w) => (collapsed ? single(w) : row(w)))
            ),
          )}

          <RemoteWorkspaces offset={workspaces.length} />

          {dragging ? (
            <div
              className="rail-drop-end"
              data-drop={target?.kind === 'end' ? 'before' : undefined}
              onDragOver={(e) => {
                if (isRailDrag(e)) handlers.over({ kind: 'end' })
              }}
            />
          ) : null}
        </div>
      </ScrollArea>

      <ViewsRail />
      <SidebarFooter />
    </>
  )
}
