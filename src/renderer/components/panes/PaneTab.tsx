import { commands } from '@/commands/registry'
import { IconButton } from '@/components/common/IconButton'
import { useDict } from '@/lib/app/useDict'
import type { PaneNode } from '@/lib/layout/types'
import { PANE_DND, beginPaneDrag, endPaneDrag } from '@/lib/panes/paneDrag'
import { cn } from '@/lib/utils'
import { usePaneRenameStore } from '@/stores/workspaces/paneRenameStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { LockSimpleIcon, XIcon } from '@phosphor-icons/react'
import { PaneRenameField } from './PaneRenameField'
import { PaneTabMenu } from './PaneTabMenu'
import { focusPane } from './SplitTab'
import { TabFace, usePaneMark } from './TabFace'
import { TabHint } from './TabHint'

export function PaneTab({
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
  const renaming = usePaneRenameStore((s) => s.paneId === pane.id)

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
      draggable={!renaming}
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
      {renaming ? (
        <PaneRenameField pane={pane} workspaceId={workspaceId} />
      ) : (
        <TabHint pane={pane}>
          <button
            type="button"
            role="tab"
            aria-selected={selected}
            className="pane-tab-main"
            onClick={() => focusPane(pane.id)}
            onDoubleClick={() => usePaneRenameStore.getState().begin(pane.id)}
          >
            <TabFace pane={pane} />
          </button>
        </TabHint>
      )}
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
