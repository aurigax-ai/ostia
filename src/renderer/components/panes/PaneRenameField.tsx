import { RenameInput } from '@/components/common/RenameInput'
import { useDict } from '@/i18n/useDict'
import type { PaneNode } from '@/layout/types'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneRenameStore } from '@/stores/workspaces/paneRenameStore'
import { usePaneTitle } from './TabFace'

export function PaneRenameField({
  pane,
  workspaceId,
}: {
  pane: PaneNode
  workspaceId: string | null
}): JSX.Element {
  const d = useDict()
  const title = usePaneTitle(pane)
  return (
    <RenameInput
      value={title}
      label={d.pane.renameTab}
      onDone={(name) => {
        usePaneRenameStore.getState().end()
        if (name === null || !workspaceId) return
        useLayoutStore.getState().rename(workspaceId, pane.id, name)
      }}
    />
  )
}
