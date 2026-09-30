import { openChatPane } from '../lib/chatPane'
import { assistProvider, useAssistStore } from '../stores/assistStore'
import { commands } from './registry'

export const CHAT_COMMAND_ID = 'assist.chat'

function syncChatCommand(): void {
  const ready = assistProvider('chat') !== null
  if (ready && !commands.has(CHAT_COMMAND_ID)) {
    commands.register({
      id: CHAT_COMMAND_ID,
      title: 'Assistant: Chat',
      category: 'Assistant',
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
