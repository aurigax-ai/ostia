import {
  ArrowClockwiseIcon,
  BookmarkSimpleIcon,
  ChatCircleTextIcon,
  CopyIcon,
  PaperPlaneTiltIcon,
} from '@phosphor-icons/react'
import type { JSX, ReactElement } from 'react'
import { MenuContent, MenuItem } from '@/components/common/Menu'
import { ContextMenu, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { addToAgentPane } from '@/lib/agent/agentPane'
import { fmt, useDict } from '@/lib/app/useDict'
import { blockOutputContext } from '@/lib/assist/askContext'
import { triggerCapture } from '@/lib/capture/captureSession'
import { copyBlock, rerunBlock } from '@/lib/terminal/blockActions'
import { isIdlePrompt } from '@/lib/terminal/blocks'
import { terminalFor } from '@/lib/terminal/terminalHandles'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useSnippetsStore } from '@/stores/terminal/snippetsStore'

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
  const typedCommand = useBlocksStore(
    (s) => s.byPane[paneId]?.find((b) => b.id === blockId)?.typedCommand,
  )
  const hasOutput = useBlocksStore((s) =>
    Boolean(s.byPane[paneId]?.find((b) => b.id === blockId)?.endLine),
  )
  const select = (): void => useBlocksStore.getState().select(paneId, blockId)

  return (
    <ContextMenu>
      <ContextMenuTrigger render={trigger} onContextMenu={select} />
      <MenuContent
        finalFocus={() => {
          if (!onClosed) return true
          onClosed()
          return false
        }}
      >
        <MenuItem icon={CopyIcon} onClick={() => void copyBlock(paneId, 'command', blockId)}>
          {d.blocks.copyCommand}
        </MenuItem>
        <MenuItem icon={CopyIcon} onClick={() => void copyBlock(paneId, 'output', blockId)}>
          {d.blocks.copyOutput}
        </MenuItem>
        <MenuItem icon={CopyIcon} onClick={() => void copyBlock(paneId, 'both', blockId)}>
          {d.blocks.copyBoth}
        </MenuItem>
        <MenuItem
          icon={PaperPlaneTiltIcon}
          onClick={() => {
            select()
            terminalFor(paneId)?.clearSelection()
            triggerCapture(paneId)
          }}
        >
          {d.blocks.sendOutput}
        </MenuItem>
        {hasOutput ? (
          <MenuItem
            icon={ChatCircleTextIcon}
            onClick={() => {
              const item = blockOutputContext(
                paneId,
                blockId,
                fmt(d.chatActions.outputOf, { command: command ?? '' }),
              )
              if (item) addToAgentPane(item)
            }}
          >
            {d.agentPane.addToPane}
          </MenuItem>
        ) : null}
        <ContextMenuSeparator />
        <MenuItem
          icon={ArrowClockwiseIcon}
          disabled={!idle || !typedCommand}
          onClick={() => rerunBlock(paneId, blockId)}
        >
          {d.blocks.rerun}
        </MenuItem>
        <MenuItem
          icon={BookmarkSimpleIcon}
          disabled={!command}
          onClick={() => useSnippetsStore.getState().startSave(command ?? null)}
        >
          {d.blocks.saveAsSnippet}
        </MenuItem>
      </MenuContent>
    </ContextMenu>
  )
}
