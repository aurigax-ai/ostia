import { workspaceOfPane } from '@/lib/attention/workspaceActivity'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { AgentResume } from '@shared/agents/agentResume'

const RESUME_BLOCK_WAIT_MS = 30_000

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
}

export function watchResumeOutcome(paneId: string, resume: AgentResume): void {
  watches.get(paneId)?.stop()
  let blockId: string | null = null
  const check = (): void => {
    const { running, byPane } = useBlocksStore.getState()
    const current = running[paneId]
    if (blockId === null) {
      if (current === undefined) return
      blockId = current
      clearTimeout(timer)
    }
    if (current === blockId) return
    const exitCode = byPane[paneId]?.find((b) => b.id === blockId)?.exitCode
    const { started } = watch
    watch.stop()
    if (!started && typeof exitCode === 'number' && exitCode !== 0) {
      failed(paneId, resume, exitCode)
    }
  }
  const unsubscribe = useBlocksStore.subscribe(check)
  const timer = setTimeout(() => watch.stop(), RESUME_BLOCK_WAIT_MS)
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
