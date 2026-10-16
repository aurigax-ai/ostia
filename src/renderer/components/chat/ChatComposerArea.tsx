import type { OstiaChatMessage } from '@/lib/assist/chatTransport'
import type { UseChatHelpers } from '@ai-sdk/react'
import type {
  AssistProviderInfo,
  ChatContextItem,
} from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import type { RefObject } from 'react'
import { ChatComposer } from './ChatComposer'
import { ChatSlashMenu } from './ChatSlashMenu'
import type { ChatComposerState } from './useChatComposer'
import type { ChatContext } from './useChatContext'

interface ChatComposerAreaProps {
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
  areaRef: RefObject<HTMLTextAreaElement>
  noticeText: string
  composer: ChatComposerState
  picking: boolean
  setPicking: (open: boolean) => void
  attachments: ChatContextItem[]
  willRedact: number
  context: ChatContext
  ask: (text: string, extra?: ChatContextItem[]) => void
  onStop: () => void
  onBack?: () => void
}

export function ChatComposerArea({
  composer,
  areaRef,
  ...rest
}: ChatComposerAreaProps): JSX.Element {
  const { toolsOpen, setToolsOpen, modelOpen, setModelOpen, setFocused } = composer
  const { pickerQuery, setPickerQuery, slash } = composer
  const { menu, rows, active, anchor, setSlashKey, pickRow } = slash
  return (
    <>
      <ChatComposer
        {...rest}
        areaRef={areaRef}
        toolsOpen={toolsOpen}
        setToolsOpen={setToolsOpen}
        modelOpen={modelOpen}
        setModelOpen={setModelOpen}
        setFocused={setFocused}
        pickerQuery={pickerQuery}
        setPickerQuery={setPickerQuery}
        slash={slash}
      />
      {menu ? (
        <ChatSlashMenu
          menu={menu}
          rows={rows}
          activeKey={active?.key}
          anchor={anchor}
          areaRef={areaRef}
          onActive={setSlashKey}
          onPick={(row) => pickRow(row, false)}
        />
      ) : null}
    </>
  )
}
