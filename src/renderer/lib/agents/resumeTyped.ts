import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { typedLaunch } from '@shared/agents/agentLaunch'
import type { AgentResume } from '@shared/agents/agentResume'

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
      ? previous?.agent === resume.agent && previous.id === resume.id
        ? previous.typed
        : undefined
      : typedLaunch(resume.agent, line)
  return typed ? { ...rest, typed } : rest
}
