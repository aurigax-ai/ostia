import { chatAvailable } from '@/lib/assist/assistFeatures'
import { openChatPane } from '@/lib/assist/chatPane'
import { useAssistStore } from '@/stores/assist/assistStore'
import { registerCore } from './core'
import { commands } from './registry'

export const CHAT_COMMAND_ID = 'assist.chat'

function syncChatCommand(): void {
  const ready = chatAvailable()
  if (ready && !commands.has(CHAT_COMMAND_ID)) {
    registerCore({
      id: CHAT_COMMAND_ID,
      category: 'assistant',
      target: 'none',
      run: () => {
        openChatPane()
      },
    })
  } else if (!ready && commands.has(CHAT_COMMAND_ID)) {
    commands.unregister(CHAT_COMMAND_ID)
  }
}

export function startChatCommand(): () => void {
  syncChatCommand()
  return useAssistStore.subscribe(syncChatCommand)
}
