import { openSelectionSend } from '../lib/selectionSenders'
import { registerCore } from './core'

export const SEND_SELECTION_COMMAND = 'selection.sendToAgent'

export function registerSelectionSendCommand(): void {
  registerCore<undefined, { opened: true }>({
    id: SEND_SELECTION_COMMAND,
    category: 'pane',
    target: 'active',
    run: (_args, ctx) => {
      if (!ctx.activePaneId || !openSelectionSend(ctx.activePaneId)) {
        throw new Error('the active pane has no selection to send')
      }
      return { opened: true }
    },
  })
}
