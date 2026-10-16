import { findPane } from '@/lib/layout/tree'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
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
      ? previous?.agent === resume.agent
        ? previous.typed
        : undefined
      : typedLaunch(resume.agent, line)
  return typed ? { ...rest, typed } : rest
}

export function typedLaunchOfNewBlock(
  workspaceId: string,
  paneId: string,
  typedLine: string | undefined,
): void {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const pane = layout ? findPane(layout.root, paneId) : null
  const resume = pane?.kind === 'terminal' ? pane.resume : undefined
  if (!resume) return
  const { typed: _previous, ...rest } = resume
  const typed = typedLine === undefined ? undefined : typedLaunch(resume.agent, typedLine)
  if (JSON.stringify(typed ?? null) === JSON.stringify(resume.typed ?? null)) return
  useLayoutStore.getState().setResume(workspaceId, paneId, typed ? { ...rest, typed } : rest)
}
