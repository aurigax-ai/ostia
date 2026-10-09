import { findPane } from '@/layout/tree'
import { useBlocksStore } from '@/stores/blocksStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useOpenWaitsStore } from '@/stores/openWaitsStore'
import type { OpenedPane } from '@shared/openFiles'

const COMMAND_SHOWN_MAX = 60

export function waitOnPanes(
  workspaceId: string,
  callerPaneId: string | undefined,
  opened: readonly OpenedPane[],
): void {
  if (opened.length === 0) return
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const caller = layout && callerPaneId ? findPane(layout.root, callerPaneId) : null
  const blocks = useBlocksStore.getState()
  const runningId = callerPaneId ? blocks.running[callerPaneId] : undefined
  const running = callerPaneId
    ? blocks.byPane[callerPaneId]?.find((block) => block.id === runningId)
    : undefined
  const command = (running?.command ?? '').split('\n', 1)[0]
  useOpenWaitsStore.getState().wait(
    opened.map((pane) => pane.paneId),
    { from: caller?.title ?? '', command: command ? command.slice(0, COMMAND_SHOWN_MAX) : null },
  )
}
