import { MenuContent, MenuItem } from '@/components/common/Menu'
import { ContextMenu, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { fmt, useDict } from '@/i18n/useDict'
import { openSelectionSend } from '@/lib/agents/selectionSenders'
import { attachAndOpenChat, blockOutputContext, explainFailedBlock } from '@/lib/assist/askContext'
import { featureEnabled, useAssistFeature, useChatAvailable } from '@/lib/assist/assistFeatures'
import { copyBlock, rerunBlock } from '@/lib/terminal/blockActions'
import { isIdlePrompt } from '@/lib/terminal/blocks'
import { terminalFor } from '@/lib/terminal/terminalHandles'
import { useAssistProvider } from '@/stores/assistStore'
import { useBlocksStore } from '@/stores/blocksStore'
import { useWorkflowsStore } from '@/stores/workflowsStore'
import {
  ArrowClockwiseIcon,
  BookmarkSimpleIcon,
  ChatCircleTextIcon,
  CopyIcon,
  PaperPlaneTiltIcon,
  QuestionIcon,
} from '@phosphor-icons/react'
import type { ReactElement } from 'react'

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
  const failed = useBlocksStore((s) => {
    const block = s.byPane[paneId]?.find((b) => b.id === blockId)
    return Boolean(block?.endLine && block.exitCode !== null && block.exitCode !== 0)
  })
  const chat = useAssistProvider('chat')
  const explainOn = featureEnabled(useAssistFeature('explainError'))
  const askOn = useChatAvailable()
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
            openSelectionSend(paneId)
          }}
        >
          {d.blocks.sendOutput}
        </MenuItem>
        {askOn && hasOutput ? (
          <MenuItem
            icon={ChatCircleTextIcon}
            onClick={() => {
              const item = blockOutputContext(
                paneId,
                blockId,
                fmt(d.chatActions.outputOf, { command: command ?? '' }),
              )
              if (item) attachAndOpenChat(item)
            }}
          >
            {d.chatActions.askAboutOutput}
          </MenuItem>
        ) : null}
        {failed && chat && explainOn ? (
          <MenuItem
            icon={QuestionIcon}
            onClick={() =>
              explainFailedBlock(paneId, blockId, {
                prompt: d.ask.explainPrompt,
                label: d.ask.context.error,
              })
            }
          >
            {d.ask.explain}
          </MenuItem>
        ) : null}
        <ContextMenuSeparator />
        <MenuItem
          icon={ArrowClockwiseIcon}
          disabled={!idle || !command}
          onClick={() => rerunBlock(paneId, blockId)}
        >
          {d.blocks.rerun}
        </MenuItem>
        <MenuItem
          icon={BookmarkSimpleIcon}
          disabled={!command}
          onClick={() => useWorkflowsStore.getState().startSave(command ?? null)}
        >
          {d.blocks.saveAsWorkflow}
        </MenuItem>
      </MenuContent>
    </ContextMenu>
  )
}
