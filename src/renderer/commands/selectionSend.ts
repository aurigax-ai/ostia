import { openSelectionSend } from '../lib/selectionSenders'
import { commands } from './registry'

export const SEND_SELECTION_COMMAND = 'selection.sendToAgent'

export function registerSelectionSendCommand(): void {
  commands.register<undefined, { opened: true }>({
    id: SEND_SELECTION_COMMAND,
    title: 'Send Selection to Agent',
    category: 'Editor',
    target: 'active',
    run: (_args, ctx) => {
      if (!ctx.activePaneId || !openSelectionSend(ctx.activePaneId)) {
        throw new Error('the active pane is not a file view')
      }
      return { opened: true }
    },
  })
}
