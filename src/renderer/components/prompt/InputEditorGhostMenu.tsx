import { ClipboardTextIcon, CopyIcon } from '@phosphor-icons/react'
import { MenuCheckboxItem, MenuContent, MenuItem } from '@/components/common/Menu'
import { ContextMenu, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useDict } from '@/lib/app/useDict'
import { type AssistFeatureRef, setAssistFeature } from '@/lib/assist/assistFeatures'
import { planDraftPaste } from '@/lib/keyboard/pasteGate'

export function InputEditorGhostMenu({
  ghostFeature,
  selectedText,
  typeAtCaret,
  field,
}: {
  ghostFeature: AssistFeatureRef | null
  selectedText: string
  typeAtCaret: (chunk: string) => void
  field: JSX.Element
}): JSX.Element {
  const d = useDict()
  return ghostFeature ? (
    <ContextMenu>
      <ContextMenuTrigger render={field} />
      <MenuContent>
        <MenuItem
          icon={CopyIcon}
          disabled={!selectedText}
          onClick={() => void navigator.clipboard.writeText(selectedText)}
        >
          {d.terminalGhost.copy}
        </MenuItem>
        <MenuItem
          icon={ClipboardTextIcon}
          onClick={() =>
            void navigator.clipboard
              .readText()
              .then((clip) => {
                const draft = planDraftPaste(clip)
                if (draft) typeAtCaret(draft)
              })
              .catch(() => {})
          }
        >
          {d.terminalGhost.paste}
        </MenuItem>
        <ContextMenuSeparator />
        <MenuCheckboxItem
          checked={ghostFeature.feature.on}
          onCheckedChange={(on) => void setAssistFeature('terminalCompletions', on)}
        >
          {d.terminalGhost.toggle}
        </MenuCheckboxItem>
      </MenuContent>
    </ContextMenu>
  ) : (
    field
  )
}
