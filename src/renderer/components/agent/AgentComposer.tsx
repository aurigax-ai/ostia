import type { UseChatHelpers } from '@ai-sdk/react'
import type { ChatContextItem } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import { type RefObject, useState } from 'react'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { ChatModeSelect } from '@/components/chat/ChatComposerControls'
import { ChatContextChips } from '@/components/chat/ChatContextChips'
import { ChatToolsMenu } from '@/components/chat/ChatToolsMenu'
import type { ChatContext } from '@/components/chat/useChatContext'
import { useDict } from '@/lib/app/useDict'
import type { OstiaChatMessage } from '@/lib/assist/chatTransport'
import { setAgentRules, useAgentStore } from '@/stores/agent/agentStore'
import { AgentModelSelect } from './AgentModelSelect'

function opensPicker(text: string, caret: number): boolean {
  if (caret < 1 || text[caret - 1] !== '@') return false
  const before = caret >= 2 ? text[caret - 2] : ''
  return before === '' || /\s/.test(before)
}

export interface AgentComposerProps {
  sessionId: string
  workspaceId: string
  attachmentKey: string
  chat: Pick<UseChatHelpers<OstiaChatMessage>, 'status'>
  busy: boolean
  ready: boolean
  draft: string
  setDraft: (draft: string) => void
  areaRef: RefObject<HTMLTextAreaElement>
  picking: boolean
  setPicking: (open: boolean) => void
  attachments: ChatContextItem[]
  willRedact: number
  context: ChatContext
  ask: (text: string) => void
  onStop: () => void
}

export function AgentComposer({
  sessionId,
  workspaceId,
  attachmentKey,
  chat,
  busy,
  ready,
  draft,
  setDraft,
  areaRef,
  picking,
  setPicking,
  attachments,
  willRedact,
  context,
  ask,
  onStop,
}: AgentComposerProps): JSX.Element {
  const d = useDict()
  const [pickerQuery, setPickerQuery] = useState('')
  const [toolsOpen, setToolsOpen] = useState(false)
  const rules = useAgentStore((s) => s.rules[sessionId]) ?? { on: true, count: 0 }
  return (
    <PromptInput className="border-line border-t p-2" onSubmit={(message) => ask(message.text)}>
      <ChatContextChips
        workspaceId={workspaceId}
        chatKey={attachmentKey}
        picking={picking}
        setPicking={setPicking}
        pickerQuery={pickerQuery}
        setPickerQuery={setPickerQuery}
        areaRef={areaRef}
        context={context}
        attachments={attachments}
        willRedact={willRedact}
        rules={{ ...rules, disabled: busy, toggle: () => void setAgentRules(sessionId, !rules.on) }}
      />
      <PromptInputBody>
        <PromptInputTextarea
          ref={areaRef}
          value={draft}
          aria-label={d.ask.question}
          placeholder={d.agentPane.placeholder}
          onChange={(e) => {
            const next = e.target.value
            const caret = e.target.selectionStart
            if (opensPicker(next, caret)) {
              setDraft(next.slice(0, caret - 1) + next.slice(caret))
              setPicking(true)
              return
            }
            setDraft(next)
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </PromptInputBody>
      <PromptInputFooter className="chat-composer-row @container flex-nowrap">
        <ChatToolsMenu
          sessionId={sessionId}
          mode="native"
          open={toolsOpen}
          onOpenChange={setToolsOpen}
        />
        <PromptInputTools className="flex-1 overflow-hidden" />
        <div className="chat-composer-controls flex min-w-0 shrink items-center gap-1">
          <ChatModeSelect sessionId={sessionId} />
          <AgentModelSelect sessionId={sessionId} />
          <PromptInputSubmit
            className="shrink-0"
            status={chat.status}
            onStop={onStop}
            disabled={!busy && !ready}
            submitLabel={d.ask.send}
            stopLabel={d.ask.stop}
          />
        </div>
      </PromptInputFooter>
    </PromptInput>
  )
}
