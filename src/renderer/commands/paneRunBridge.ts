import { runWhenIdle } from '../lib/blockActions'

export function wirePaneRunBridge(): void {
  window.ostia?.pty?.onRun?.((paneId, command) => {
    runWhenIdle(paneId, command)
  })
}
