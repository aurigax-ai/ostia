import { runWhenIdle } from '../lib/blockActions'

export function wirePaneRunBridge(): void {
  window.pine?.pty?.onRun?.((paneId, command) => {
    runWhenIdle(paneId, command)
  })
}
