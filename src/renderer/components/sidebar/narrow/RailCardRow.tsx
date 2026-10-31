import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { selectWorkspace } from '@/lib/workspaces/selectWorkspace'
import { workspaceTitle } from '@/lib/workspaces/workspaceTitle'
import { useRailEditStore } from '@/stores/workspaces/railEditStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { PathLine } from '../RailMeta'
import { RowFact } from '../row/RowFact'
import { useWorkspaceFlags } from '../WorkspaceBadges'
import { WorkspaceDescription } from '../WorkspaceDetails'
import { WorkspaceIcon } from '../WorkspaceIcon'
import { WorkspaceMenu } from '../WorkspaceMenu'

export function RailCardRow({
  workspace: w,
  onPick,
}: {
  workspace: Workspace
  onPick: () => void
}): JSX.Element {
  const { sandboxed, locked } = useWorkspaceFlags(w.id)
  const path = w.projectDir ?? w.workDir
  const edit = useRailEditStore.getState
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <button
          type="button"
          data-card-row
          className="rail-card-row"
          onClick={() => {
            selectWorkspace(w.id)
            onPick()
          }}
        >
          <WorkspaceIcon workspace={w} />
          <span className="rail-card-text">
            <span className="rail-card-name">{workspaceTitle(w)}</span>
            {w.description ? <WorkspaceDescription text={w.description} /> : null}
            {path ? <PathLine path={path} hint={false} /> : null}
            <RowFact workspace={w} offline={null} showLive />
          </span>
        </button>
      </ContextMenuTrigger>
      <WorkspaceMenu
        workspace={w}
        sandboxed={sandboxed}
        locked={locked}
        onEdit={(field) => {
          if (field) edit().begin({ kind: 'workspace', id: w.id, field })
        }}
        onGroupCreated={(id) => edit().begin({ kind: 'group', id })}
      />
    </ContextMenu>
  )
}
