import { chatAvailable } from '@/lib/assist/assistFeatures'
import { useAssistStore } from '../stores/assistStore'
import { useUIStore } from '../stores/uiStore'
import { registerCore } from './core'
import { commands } from './registry'

export const ASK_COMMAND_ID = 'assist.ask'

function syncAskCommand(): void {
  const ready = chatAvailable()
  if (ready && !commands.has(ASK_COMMAND_ID)) {
    registerCore({
      id: ASK_COMMAND_ID,
      category: 'assistant',
      target: 'none',
      run: () => {
        useUIStore.getState().showWorkspaces()
        useUIStore.getState().openPalette('ask')
      },
    })
  } else if (!ready && commands.has(ASK_COMMAND_ID)) {
    commands.unregister(ASK_COMMAND_ID)
  }
}

export function startAskCommand(): () => void {
  syncAskCommand()
  return useAssistStore.subscribe(syncAskCommand)
}
