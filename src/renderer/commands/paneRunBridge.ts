import { runWhenIdle } from '@/lib/terminal/blockActions'

export function wirePaneRunBridge(): void {
  window.ostia?.pty?.onRun?.((paneId, command) => {
    runWhenIdle(paneId, command)
  })
}
