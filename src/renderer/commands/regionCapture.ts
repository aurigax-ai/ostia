import { startRegionCapture } from '../lib/regionCaptures'
import { registerCore } from './core'

export const CAPTURE_REGION_COMMAND = 'browser.captureRegion'

export function registerRegionCaptureCommand(): void {
  registerCore<undefined, { started: true }>({
    id: CAPTURE_REGION_COMMAND,
    category: 'pane',
    local: true,
    run: (_args, ctx) => {
      if (!ctx.activePaneId || !startRegionCapture(ctx.activePaneId)) {
        throw new Error('the active pane is not a browser pane')
      }
      return { started: true }
    },
  })
}
