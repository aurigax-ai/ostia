import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { commandLineEnv } from '@shared/agents/agentLaunch'
import type { AgentResume } from '@shared/agents/agentResume'

function runningCommand(paneId: string): string | undefined {
  const { running, byPane } = useBlocksStore.getState()
  const blockId = running[paneId]
  return blockId ? byPane[paneId]?.find((block) => block.id === blockId)?.typedCommand : undefined
}

export function withCommandLineEnv(resume: AgentResume | null, paneId: string): AgentResume | null {
  if (!resume) return null
  const command = runningCommand(paneId)
  const env = command === undefined ? null : commandLineEnv(resume.agent, command)
  if (env === null) return resume
  const { env: _previous, ...rest } = resume
  return Object.keys(env).length > 0 ? { ...rest, env } : rest
}
