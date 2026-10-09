import { MenuContent, MenuItem } from '@/components/common/Menu'
import { ContextMenu, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useDict } from '@/i18n/useDict'
import { clearKeepingScrollback } from '@/lib/clearTerminal'
import type { OstiaTerminal as Xterm } from '@/lib/ostiaTerminal'
import { useBlocksStore } from '@/stores/blocksStore'
import { BroomIcon, ClipboardTextIcon, CopyIcon, SelectionAllIcon } from '@phosphor-icons/react'
import { type MutableRefObject, type ReactElement, useState } from 'react'

export function TerminalMenu({
  paneId,
  termRef,
  onPaste,
  trigger,
}: {
  paneId: string
  termRef: MutableRefObject<Xterm | null>
  onPaste: () => void
  trigger: ReactElement
}): JSX.Element {
  const d = useDict()
  const [hasSelection, setHasSelection] = useState(false)
  const refocus = (): void => {
    requestAnimationFrame(() => termRef.current?.focus())
  }
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) setHasSelection(Boolean(termRef.current?.hasSelection()))
      }}
    >
      <ContextMenuTrigger render={trigger} />
      <MenuContent
        finalFocus={() => {
          refocus()
          return false
        }}
      >
        <MenuItem
          icon={CopyIcon}
          disabled={!hasSelection}
          onClick={() => {
            const term = termRef.current
            if (term?.hasSelection()) void navigator.clipboard.writeText(term.getSelection())
          }}
        >
          {d.terminalMenu.copy}
        </MenuItem>
        <MenuItem icon={ClipboardTextIcon} onClick={onPaste}>
          {d.terminalMenu.paste}
        </MenuItem>
        <MenuItem icon={SelectionAllIcon} onClick={() => termRef.current?.selectAll()}>
          {d.terminalMenu.selectAll}
        </MenuItem>
        <ContextMenuSeparator />
        <MenuItem
          icon={BroomIcon}
          onClick={() => {
            const term = termRef.current
            if (term) void clearKeepingScrollback(term, !useBlocksStore.getState().running[paneId])
          }}
        >
          {d.terminalMenu.clear}
        </MenuItem>
      </MenuContent>
    </ContextMenu>
  )
}
