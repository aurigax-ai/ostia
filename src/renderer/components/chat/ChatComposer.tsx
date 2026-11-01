import type { UseChatHelpers } from '@ai-sdk/react'
import type {
  AssistProviderInfo,
  ChatContextItem,
} from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import type { JSX, RefObject } from 'react'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { TextLink } from '@/components/common/TextLink'
import { useDict } from '@/lib/app/useDict'
import type { OstiaChatMessage } from '@/lib/assist/chatTransport'
import { ChatModelSelect, ChatModeSelect } from './ChatComposerControls'
import { ChatContextChips } from './ChatContextChips'
import { ChatToolsMenu } from './ChatToolsMenu'
import type { ChatContext } from './useChatContext'
import type { ChatSlash } from './useChatSlash'

function opensPicker(text: string, caret: number): boolean {
  if (caret < 1 || text[caret - 1] !== '@') return false
  const before = caret >= 2 ? text[caret - 2] : ''
  return before === '' || /\s/.test(before)
}

export interface ChatComposerProps {
  sessionId: string
  workspaceId: string | null
  chatKey: string
  chat: Pick<UseChatHelpers<OstiaChatMessage>, 'messages' | 'status'>
  provider: AssistProviderInfo | null
  busy: boolean
  draft: string
  setDraft: (draft: string) => void
  editing: string | null
  setEditing: (id: string | null) => void
  areaRef: RefObject<HTMLTextAreaElement | null>
  noticeText: string
  toolsOpen: boolean
  setToolsOpen: (open: boolean) => void
  modelOpen: boolean
  setModelOpen: (open: boolean) => void
  setFocused: (focused: boolean) => void
  picking: boolean
  setPicking: (open: boolean) => void
  pickerQuery: string
  setPickerQuery: (query: string) => void
  attachments: ChatContextItem[]
  willRedact: number
  context: ChatContext
  slash: ChatSlash
  ask: (text: string, extra?: ChatContextItem[]) => void
  onStop: () => void
  onBack?: () => void
}

export function ChatComposer({
  sessionId,
  workspaceId,
  chatKey,
  chat,
  provider,
  busy,
  draft,
  setDraft,
  editing,
  setEditing,
  areaRef,
  noticeText,
  toolsOpen,
  setToolsOpen,
  modelOpen,
  setModelOpen,
  setFocused,
  picking,
  setPicking,
  pickerQuery,
  setPickerQuery,
  attachments,
  willRedact,
  context,
  slash,
  ask,
  onStop,
  onBack,
}: ChatComposerProps): JSX.Element {
  const d = useDict()
  const { messages, status } = chat
  const { menuOpen, setSlashNotice, onSlashKey, executeSlash } = slash
  return (
    <PromptInput
      className="border-line border-t p-2"
      onSubmit={(message) => {
        if (!executeSlash(message.text)) ask(message.text)
      }}
    >
      <ChatContextChips
        workspaceId={workspaceId}
        chatKey={chatKey}
        picking={picking}
        setPicking={setPicking}
        pickerQuery={pickerQuery}
        setPickerQuery={setPickerQuery}
        areaRef={areaRef}
        context={context}
        attachments={attachments}
        willRedact={willRedact}
      />
      <PromptInputBody>
        <PromptInputTextarea
          ref={areaRef}
          value={draft}
          role="combobox"
          aria-label={d.ask.question}
          aria-expanded={menuOpen}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          placeholder={d.chatSlash.placeholder}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            const next = e.target.value
            const caret = e.target.selectionStart
            setSlashNotice(null)
            if (opensPicker(next, caret)) {
              setDraft(next.slice(0, caret - 1) + next.slice(caret))
              setPicking(true)
              return
            }
            setDraft(next)
          }}
          onKeyDown={(e) => {
            if (onSlashKey(e)) {
              e.preventDefault()
              e.stopPropagation()
              return
            }
            if (e.key === 'Escape') {
              if (editing) {
                e.preventDefault()
                e.stopPropagation()
                setEditing(null)
                setDraft('')
              }
              return
            }
            e.stopPropagation()
            if (e.key === 'Backspace' && draft === '' && messages.length === 0 && onBack) {
              e.preventDefault()
              onBack()
            }
          }}
        />
      </PromptInputBody>
      <PromptInputFooter className="chat-composer-row @container flex-nowrap">
        {provider?.tools ? (
          <ChatToolsMenu
            sessionId={sessionId}
            mode={provider.tools}
            open={toolsOpen}
            onOpenChange={setToolsOpen}
          />
        ) : null}
        <PromptInputTools className="flex-1 overflow-hidden">
          {editing ? (
            <span className="flex min-w-0 items-center gap-1 px-1 text-fg-muted text-ui-xs">
              <span className="truncate">{d.chatActions.editing}</span>
              <TextLink
                type="button"
                size="xs"
                className="h-5 px-1 text-ui-xs"
                onClick={() => {
                  setEditing(null)
                  setDraft('')
                }}
              >
                {d.chatActions.cancelEdit}
              </TextLink>
            </span>
          ) : (
            <p aria-live="polite" className="truncate px-1 text-fg-muted text-ui-xs empty:hidden">
              {noticeText}
            </p>
          )}
        </PromptInputTools>
        <div className="chat-composer-controls flex min-w-0 shrink items-center gap-1">
          {provider ? <ChatModeSelect sessionId={sessionId} /> : null}
          <ChatModelSelect sessionId={sessionId} open={modelOpen} onOpenChange={setModelOpen} />
          <PromptInputSubmit
            className="shrink-0"
            status={status}
            onStop={onStop}
            disabled={!busy && !provider}
            submitLabel={d.ask.send}
            stopLabel={d.ask.stop}
          />
        </div>
      </PromptInputFooter>
    </PromptInput>
  )
}
