import type { AgentResume } from '@shared/agents/agentResume'
import { workspaceOfPane } from '@/lib/attention/workspaceActivity'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

const RESUME_START_WAIT_MS = 30_000
export const RESUME_FAIL_WINDOW_MS = 30_000
const SIGNAL_EXIT = 128

interface Watch {
  started: boolean
  stop: () => void
}

const watches = new Map<string, Watch>()

export function resumeStarted(paneId: string): void {
  const watch = watches.get(paneId)
  if (watch) watch.started = true
}

function failed(paneId: string, resume: AgentResume, exitCode: number): void {
  const workspaceId = workspaceOfPane(paneId)
  if (workspaceId) useLayoutStore.getState().failResume(workspaceId, paneId, resume, exitCode)
  window.ostia.pty.reportWaking(
    paneId,
    false,
    `its agent exited with code ${exitCode} before it started`,
  )
}

function isFailure(exitCode: number | null | undefined): exitCode is number {
  return typeof exitCode === 'number' && exitCode > 0 && exitCode < SIGNAL_EXIT
}

export function watchResumeOutcome(paneId: string, resume: AgentResume): void {
  watches.get(paneId)?.stop()
  if (useSettingsStore.getState().agents.hooks[resume.agent] === false) return
  let blockId: string | null = null
  let timer = setTimeout(() => watch.stop(), RESUME_START_WAIT_MS)
  const check = (): void => {
    const { running, byPane } = useBlocksStore.getState()
    const current = running[paneId]
    if (blockId === null) {
      if (current === undefined) return
      blockId = current
      clearTimeout(timer)
      timer = setTimeout(() => watch.stop(), RESUME_FAIL_WINDOW_MS)
    }
    if (current === blockId) return
    const exitCode = byPane[paneId]?.find((b) => b.id === blockId)?.exitCode
    const { started } = watch
    watch.stop()
    if (!started && isFailure(exitCode)) failed(paneId, resume, exitCode)
  }
  const unsubscribe = useBlocksStore.subscribe(check)
  const watch: Watch = {
    started: false,
    stop: () => {
      clearTimeout(timer)
      unsubscribe()
      if (watches.get(paneId) === watch) watches.delete(paneId)
    },
  }
  watches.set(paneId, watch)
  check()
}
