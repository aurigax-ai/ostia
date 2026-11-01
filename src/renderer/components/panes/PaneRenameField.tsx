import type { JSX } from 'react'
import { RenameInput } from '@/components/common/RenameInput'
import { useDict } from '@/lib/app/useDict'
import type { PaneNode } from '@/lib/layout/types'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneRenameStore } from '@/stores/workspaces/paneRenameStore'

export function PaneRenameField({
  pane,
  workspaceId,
}: {
  pane: PaneNode
  workspaceId: string | null
}): JSX.Element {
  const d = useDict()
  const title = pane.title
  return (
    <RenameInput
      value={title}
      label={d.pane.renameTab}
      onDone={(name) => {
        usePaneRenameStore.getState().end()
        if (name === null || !workspaceId) return
        if (!pane.titlePinned && name.trim() === title) return
        useLayoutStore.getState().rename(workspaceId, pane.id, name)
      }}
    />
  )
}
