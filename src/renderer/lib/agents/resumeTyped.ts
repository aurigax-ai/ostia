import { typedLaunch } from '@shared/agents/agentLaunch'
import type { AgentResume } from '@shared/agents/agentResume'
import { findPane } from '@/lib/layout/tree'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

function runningTypedCommand(paneId: string): string | undefined {
  const { running, byPane } = useBlocksStore.getState()
  const blockId = running[paneId]
  return blockId ? byPane[paneId]?.find((block) => block.id === blockId)?.typedCommand : undefined
}

export function withTypedLaunch(
  resume: AgentResume | null,
  paneId: string,
  previous: AgentResume | undefined,
): AgentResume | null {
  if (!resume) return null
  const { typed: _reported, ...rest } = resume
  const line = runningTypedCommand(paneId)
  const typed =
    line === undefined
      ? previous?.agent === resume.agent
        ? previous.typed
        : undefined
      : typedLaunch(resume.agent, line)
  return typed ? { ...rest, typed } : rest
}

export function clearTypedLaunchOnNewBlock(
  workspaceId: string,
  paneId: string,
  line: string | undefined,
  replayed: boolean,
): void {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const pane = layout ? findPane(layout.root, paneId) : null
  const resume = pane?.kind === 'terminal' ? pane.resume : undefined
  if (!resume?.typed) return
  const parsed = line === undefined ? undefined : typedLaunch(resume.agent, line)
  const same = JSON.stringify(parsed ?? null) === JSON.stringify(resume.typed)
  if (same || (replayed && parsed === undefined)) return
  const { typed: _typed, ...rest } = resume
  useLayoutStore.getState().setResume(workspaceId, paneId, rest)
}
