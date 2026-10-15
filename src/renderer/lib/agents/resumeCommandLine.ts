import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { commandLineEnv, typedCommandFlags } from '@shared/agents/agentLaunch'
import type { AgentResume } from '@shared/agents/agentResume'

function runningCommand(paneId: string): string | undefined {
  const { running, byPane } = useBlocksStore.getState()
  const blockId = running[paneId]
  return blockId ? byPane[paneId]?.find((block) => block.id === blockId)?.command : undefined
}

export function withCommandLine(resume: AgentResume | null, paneId: string): AgentResume | null {
  if (!resume) return null
  const command = runningCommand(paneId)
  if (command === undefined) return resume
  const env = commandLineEnv(resume.agent, command) ?? {}
  const args = [...(resume.args ?? []), ...(typedCommandFlags(resume.agent, command) ?? [])]
  return {
    ...resume,
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  }
}
