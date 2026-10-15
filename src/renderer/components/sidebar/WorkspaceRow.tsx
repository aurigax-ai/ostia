import { RenameInput } from '@/components/common/RenameInput'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Kbd } from '@/components/ui/kbd'
import { fmt, useDict } from '@/lib/app/useDict'
import { hasLockedPane } from '@/lib/layout/paneFields'
import { beginDrag, endWorkspaceDrag, isPaneDrag } from '@/lib/panes/paneDrag'
import { type RowDropZone, rowDropZone } from '@/lib/sidebar/railDropZone'
import { requestCloseWorkspace } from '@/lib/workspaces/closeConfirm'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useRailEditStore } from '@/stores/workspaces/railEditStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { ArrowSquareInIcon, ArrowsMergeIcon } from '@phosphor-icons/react'
import { useEffect } from 'react'
import { RailTab } from './RailTab'
import { WorkspaceDetails } from './WorkspaceDetails'
import { WorkspaceMenu } from './WorkspaceMenu'
import { WorkspaceBadges, WorkspaceIcon } from './WorkspaceStatus'
import {
  type DragHandlers,
  type TabDropHandlers,
  WORKSPACE_DND,
  dragFraction,
  isRailDrag,
  takesDraggedTab,
} from './railDrag'

export function WorkspaceRow({
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
  const title = w.customName ?? w.name
  const sandboxed = useSandboxStore((s) => s.enabled[w.id] ?? false)
  const locked = useLayoutStore((s) => {
    const root = s.byWorkspace[w.id]?.root
    return root ? hasLockedPane(root) : false
  })
  useEffect(() => {
    void useSandboxStore.getState().load(w.id)
  }, [w.id])
  const select = (): void => {
    useUIStore.getState().showWorkspaces()
    store().setActive(w.id)
  }
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
          e.preventDefault()
          e.stopPropagation()
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
            return
          }
          if (!isRailDrag(e)) return
          e.preventDefault()
          e.stopPropagation()
          drag.drop()
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
          titleAdornment={<WorkspaceBadges workspace={w} sandboxed={sandboxed} locked={locked} />}
          editor={editor}
          onDoubleClick={() => setEditing('name')}
          after={editing === null ? <WorkspaceDetails workspace={w} onSelect={select} /> : null}
          badge={digitHints && index < 9 ? <Kbd className="tab-digit">{index + 1}</Kbd> : null}
        />
        {drop === 'merge' || drop === 'tab' ? (
          <output className="rail-drop-chip motion-enter">
            {drop === 'tab' ? <ArrowSquareInIcon size={12} /> : <ArrowsMergeIcon size={12} />}
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
}
