import type { ReactElement } from 'react'
import { usePaneAgentSession } from '@/components/agents/AgentSessionButton'
import { Hint } from '@/components/common/Hint'
import { useDict } from '@/lib/app/useDict'
import type { PaneNode } from '@/lib/layout/types'
import { stateLabel } from '@/lib/workspaces/workspaceState'
import { useDiffStore } from '@/stores/files/diffStore'

export function TabHint({
  pane,
  children,
}: {
  pane: PaneNode
  children: ReactElement
}): JSX.Element {
  const d = useDict()
  const title = pane.title
  const session = usePaneAgentSession(pane)
  const diffPath = useDiffStore((s) => (pane.kind === 'diff' ? s.byPane[pane.id]?.path : undefined))
  const folder = pane.kind === 'terminal' ? (session?.cwd ?? pane.cwd) : diffPath
  return (
    <Hint
      side="bottom"
      label={
        <span className="flex max-w-96 flex-col gap-0.5">
          <span className="break-words">{title}</span>
          {folder ? (
            <span className="break-all font-mono text-ui-xs opacity-70">{folder}</span>
          ) : null}
          {session ? (
            <span className="text-ui-xs opacity-70">
              {d.agentSession[session.agent]} · {stateLabel(d, session.state)}
            </span>
          ) : null}
        </span>
      }
    >
      {children}
    </Hint>
  )
}
