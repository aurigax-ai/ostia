import { ArrowSquareInIcon, ArrowsMergeIcon } from '@phosphor-icons/react'
import { memo } from 'react'
import { RenameInput } from '@/components/common/RenameInput'
import { useWorkspaceFlags, WorkspaceBadges } from '@/components/sidebar/WorkspaceBadges'
import { WorkspaceIcon } from '@/components/sidebar/WorkspaceIcon'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Kbd } from '@/components/ui/kbd'
import { fmt, useDict } from '@/lib/app/useDict'
import { beginDrag, endWorkspaceDrag, isPaneDrag } from '@/lib/panes/paneDrag'
import { type RowDropZone, rowDropZone } from '@/lib/sidebar/railDropZone'
import { requestCloseWorkspace } from '@/lib/workspaces/closeConfirm'
import { selectWorkspace } from '@/lib/workspaces/selectWorkspace'
import { workspaceTitle } from '@/lib/workspaces/workspaceTitle'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useRailEditStore } from '@/stores/workspaces/railEditStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { RailTab } from './RailTab'
import {
  type DragHandlers,
  dragFraction,
  isRailDrag,
  type TabDropHandlers,
  takesDraggedTab,
  WORKSPACE_DND,
} from './railDrag'
import { WorkspaceDetails } from './WorkspaceDetails'
import { WorkspaceMenu } from './WorkspaceMenu'

export const WorkspaceRow = memo(function WorkspaceRow({
  workspace: w,
  index,
  active,
  drop,
  mergeable,
  drag,
  tabDrop,
  onGroupCreated,
}: {
  workspace: Workspace
  index: number
  active: boolean
  drop: RowDropZone | null
  mergeable: boolean
  drag: DragHandlers
  tabDrop: TabDropHandlers
  onGroupCreated: (groupId: string) => void
}): JSX.Element {
  const wrapTitles = useSettingsStore((s) => s.workspaces.wrapTitles)
  const d = useDict()
  const store = useWorkspacesStore.getState
  const digitHints = useUIStore((s) => s.digitHints)
  const editing = useRailEditStore((s) =>
    s.editing?.kind === 'workspace' && s.editing.id === w.id ? s.editing.field : null,
  )
  const setEditing = (field: 'name' | 'description' | null): void => {
    const edit = useRailEditStore.getState()
    if (field !== null) edit.begin({ kind: 'workspace', id: w.id, field })
    else if (editing !== null) edit.end({ kind: 'workspace', id: w.id, field: editing })
  }
  const title = workspaceTitle(w)
  const { sandboxed, locked } = useWorkspaceFlags(w.id)
  const select = (): void => selectWorkspace(w.id)
  const editor =
    editing === null ? undefined : (
      <RenameInput
        value={editing === 'name' ? title : (w.description ?? '')}
        label={editing === 'name' ? d.rail.renameWorkspace : d.rail.describeWorkspace}
        onDone={(text) => {
          setEditing(null)
          if (text === null) return
          if (editing === 'name') store().rename(w.id, text)
          else store().describe(w.id, text)
        }}
      />
    )

  return (
    <ContextMenu>
      <ContextMenuTrigger
        className="rail-row"
        data-drop={drop ?? undefined}
        data-mergeable={mergeable || undefined}
        draggable={editing === null}
        onDragStart={(e) => {
          e.stopPropagation()
          e.dataTransfer.setData(WORKSPACE_DND, w.id)
          e.dataTransfer.effectAllowed = 'move'
          beginDrag(e)
          drag.start({ kind: 'workspace', id: w.id })
        }}
        onDragOver={(e) => {
          if (isPaneDrag([...e.dataTransfer.types])) {
            if (!rowDropZone('tab', dragFraction(e), takesDraggedTab(w.id))) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            tabDrop.over(w.id)
            return
          }
          if (!isRailDrag(e)) return
          const zone = rowDropZone('workspace', dragFraction(e), mergeable)
          if (zone === 'merge') drag.over({ kind: 'merge', id: w.id })
          else if (zone === 'before' || zone === 'after') {
            drag.over({ kind: 'workspace', id: w.id, place: zone })
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) tabDrop.leave(w.id)
        }}
        onDrop={(e) => {
          if (isPaneDrag([...e.dataTransfer.types])) {
            if (!takesDraggedTab(w.id)) return
            e.preventDefault()
            tabDrop.drop(w.id)
          }
        }}
        onDragEnd={(e) => {
          drag.end()
          endWorkspaceDrag(w.id, e)
        }}
      >
        <RailTab
          active={active}
          onSelect={select}
          onClose={locked ? undefined : () => void requestCloseWorkspace(w.id)}
          closeLabel={d.rail.close}
          icon={<WorkspaceIcon workspace={w} />}
          title={title}
          wrapTitle={wrapTitles}
          titleAdornment={<WorkspaceBadges workspace={w} />}
          editor={editor}
          onDoubleClick={() => setEditing('name')}
          after={editing === null ? <WorkspaceDetails workspace={w} onSelect={select} /> : null}
          badge={digitHints && index < 9 ? <Kbd className="tab-digit">{index + 1}</Kbd> : null}
        />
        {drop === 'merge' || drop === 'tab' ? (
          <output className="rail-drop-chip motion-enter">
            {drop === 'tab' ? <ArrowSquareInIcon size={16} /> : <ArrowsMergeIcon size={16} />}
            <span className="rail-drop-chip-label text-ui-xs">
              {fmt(drop === 'tab' ? d.tabMove.into : d.merge.menuInto, { name: title })}
            </span>
          </output>
        ) : null}
      </ContextMenuTrigger>
      <WorkspaceMenu
        workspace={w}
        sandboxed={sandboxed}
        locked={locked}
        onEdit={setEditing}
        onGroupCreated={onGroupCreated}
      />
    </ContextMenu>
  )
})
