import type { ChatContextItem } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import {
  FileIcon,
  FolderSimpleIcon,
  type Icon,
  ListChecksIcon,
  SelectionIcon,
  TagIcon,
  TextAlignLeftIcon,
} from '@phosphor-icons/react'
import type { RefObject } from 'react'
import { PromptInputHeader } from '@/components/ai-elements/prompt-input'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import type { AskContextKind } from '@/lib/assist/askContext'
import { baseName } from '@/lib/files/fileTree'
import { useChatStore } from '@/stores/assist/chatStore'
import { AttachmentChips, ChatContextPicker } from './ChatContextPicker'
import type { ChatContext } from './useChatContext'
import { focusAtEnd } from './useChatFocus'

const CONTEXT_ICONS: Record<AskContextKind, Icon> = {
  cwd: FolderSimpleIcon,
  editor: FileIcon,
  output: TextAlignLeftIcon,
  selection: SelectionIcon,
  pane: TagIcon,
}

interface ChatContextChipsProps {
  workspaceId: string | null
  chatKey: string
  picking: boolean
  setPicking: (open: boolean) => void
  pickerQuery: string
  setPickerQuery: (query: string) => void
  areaRef: RefObject<HTMLTextAreaElement>
  context: ChatContext
  attachments: ChatContextItem[]
  willRedact: number
  rules?: { on: boolean; count: number; disabled: boolean; toggle: () => void }
}

export function ChatContextChips({
  workspaceId,
  chatKey: key,
  picking,
  setPicking,
  pickerQuery,
  setPickerQuery,
  areaRef,
  context,
  attachments,
  willRedact,
  rules,
}: ChatContextChipsProps): JSX.Element {
  const d = useDict()
  const labels = d.ask.context
  const { available, enabled, toggle, options, selectedRef, editorFile } = context
  return (
    <PromptInputHeader>
      <ChatContextPicker
        workspaceId={workspaceId}
        open={picking}
        query={pickerQuery}
        onOpenChange={(open) => {
          setPicking(open)
          if (open) return
          setPickerQuery('')
          requestAnimationFrame(() => focusAtEnd(areaRef.current))
        }}
        onAttach={(item) => useChatStore.getState().attach(key, item)}
      />
      {rules && (rules.count > 0 || !rules.on) ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-pressed={rules.on}
          disabled={rules.disabled}
          title={rules.on ? d.agentPane.rulesOn : d.agentPane.rulesOff}
          onClick={rules.toggle}
          className="ask-chip"
        >
          <ListChecksIcon />
          <span>{d.agentPane.rules}</span>
          {rules.on ? <span className="font-mono text-ui-xs">{rules.count}</span> : null}
        </Button>
      ) : null}
      {available.length > 0 ? (
        <fieldset aria-label={d.ask.contextGroup} className="flex min-w-0 flex-wrap gap-1">
          {available.map((kind) => {
            const IconFor = CONTEXT_ICONS[kind]
            const on = enabled.has(kind)
            return (
              <Button
                key={kind}
                type="button"
                variant="ghost"
                size="xs"
                aria-pressed={on}
                onClick={() => toggle(kind)}
                className="ask-chip"
              >
                <IconFor />
                <span>{labels[kind]}</span>
                {kind === 'cwd' && options.cwd ? (
                  <span className="max-w-48 truncate font-mono text-ui-xs">{options.cwd.text}</span>
                ) : null}
                {kind === 'selection' && selectedRef ? (
                  <span className="max-w-48 truncate font-mono text-ui-xs">{selectedRef}</span>
                ) : null}
                {kind === 'editor' && editorFile ? (
                  <span className="max-w-48 truncate font-mono text-ui-xs">
                    {baseName(editorFile)}
                  </span>
                ) : null}
              </Button>
            )
          })}
        </fieldset>
      ) : null}
      <AttachmentChips
        items={attachments}
        onRemove={(index) => useChatStore.getState().detach(key, index)}
      />
      {willRedact > 0 ? (
        <output className="px-1 text-fg-muted text-ui-xs" data-testid="chat-redaction-count">
          {willRedact === 1
            ? d.privacy.willRedactOne
            : fmt(d.privacy.willRedactMany, { count: willRedact })}
        </output>
      ) : null}
    </PromptInputHeader>
  )
}
