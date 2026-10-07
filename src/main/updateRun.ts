import {
  type InstallMethod,
  type UpdateRunStart,
  type UpdateRunState,
  updateCommandLine,
} from '../shared/installMethod'
import { PRODUCT_NAME } from '../shared/product'

export interface UpdateTerminalRequest {
  command: string
  hostToken: string
  title: string
}

export interface UpdateRunner {
  start: () => Promise<UpdateRunStart>
  state: () => UpdateRunState
  paneState: (paneId: string, running: boolean, exitCode: number | undefined) => void
  paneClosed: (paneId: string) => void
}

export function updateTerminalTitle(): string {
  return `Update ${PRODUCT_NAME}`
}

export function createUpdateRunner(deps: {
  method: () => InstallMethod
  openTerminal: (req: UpdateTerminalRequest) => Promise<string | null>
  hostToken: (command: string) => string
  onChange: (state: UpdateRunState) => void
}): UpdateRunner {
  let state: UpdateRunState = { status: 'idle' }
  let paneId: string | null = null
  let opening = false

  const set = (next: UpdateRunState): void => {
    state = next
    deps.onChange(next)
  }

  return {
    start: async () => {
      const command = updateCommandLine(deps.method())
      if (!command) return 'no-action'
      if (opening || state.status === 'running') return 'busy'
      opening = true
      try {
        const opened = await deps.openTerminal({
          command,
          hostToken: deps.hostToken(command),
          title: updateTerminalTitle(),
        })
        if (!opened) return 'not-opened'
        paneId = opened
        set({ status: 'running' })
        return 'opened'
      } finally {
        opening = false
      }
    },
    state: () => state,
    paneState: (id, running, exitCode) => {
      if (id !== paneId || state.status !== 'running') return
      if (running || exitCode === undefined) return
      paneId = null
      set(exitCode === 0 ? { status: 'done' } : { status: 'failed', exitCode })
    },
    paneClosed: (id) => {
      if (id !== paneId || state.status !== 'running') return
      paneId = null
      set({ status: 'failed', exitCode: null })
    },
  }
}
