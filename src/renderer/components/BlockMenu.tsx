import type { ReactElement } from 'react'
import { useDict } from '../i18n/useDict'
import { copyBlock, rerunBlock } from '../lib/blockActions'
import { isIdlePrompt } from '../lib/blocks'
import { useBlocksStore } from '../stores/blocksStore'
import { useWorkflowsStore } from '../stores/workflowsStore'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu'

export function BlockMenu({
  paneId,
  blockId,
  trigger,
  onClosed,
}: {
  paneId: string
  blockId: string
  trigger: ReactElement
  onClosed?: () => void
}): JSX.Element {
  const d = useDict()
  const idle = useBlocksStore((s) => isIdlePrompt(s, paneId))
  const command = useBlocksStore((s) => s.byPane[paneId]?.find((b) => b.id === blockId)?.command)
  const select = (): void => useBlocksStore.getState().select(paneId, blockId)

  return (
    <ContextMenu>
      <ContextMenuTrigger render={trigger} onContextMenu={select} />
      <ContextMenuContent
        className="min-w-48"
        finalFocus={() => {
          if (!onClosed) return true
          onClosed()
          return false
        }}
      >
        <ContextMenuItem onClick={() => void copyBlock(paneId, 'command', blockId)}>
          {d.blocks.copyCommand}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void copyBlock(paneId, 'output', blockId)}>
          {d.blocks.copyOutput}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void copyBlock(paneId, 'both', blockId)}>
          {d.blocks.copyBoth}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!idle || !command} onClick={() => rerunBlock(paneId, blockId)}>
          {d.blocks.rerun}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!command}
          onClick={() => useWorkflowsStore.getState().startSave(command ?? null)}
        >
          {d.blocks.saveAsWorkflow}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
