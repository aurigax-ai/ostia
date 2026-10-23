import { triggerCapture } from '@/lib/capture/captureSession'
import { registerCore } from './coreCommand'

export const SEND_SELECTION_COMMAND = 'selection.sendToAgent'

export function registerSelectionSendCommand(): void {
  registerCore<undefined, { opened: true }>({
    id: SEND_SELECTION_COMMAND,
    category: 'pane',
    target: 'active',
    local: true,
    run: (_args, ctx) => {
      if (!ctx.activePaneId || !triggerCapture(ctx.activePaneId)) {
        throw new Error('the active pane has no selection to send')
      }
      return { opened: true }
    },
  })
}
