import type { ReactElement } from 'react'
import { useDict } from '../i18n/useDict'
import { copyBlock, rerunBlock } from '../lib/blockActions'
import { isIdlePrompt } from '../lib/blocks'
import { useBlocksStore } from '../stores/blocksStore'
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
  const hasCommand = useBlocksStore((s) =>
    Boolean(s.byPane[paneId]?.find((b) => b.id === blockId)?.command),
  )
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
        <ContextMenuItem
          disabled={!idle || !hasCommand}
          onClick={() => rerunBlock(paneId, blockId)}
        >
          {d.blocks.rerun}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
