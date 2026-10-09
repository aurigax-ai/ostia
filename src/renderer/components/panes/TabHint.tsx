import { usePaneAgentSession } from '@/components/agents/AgentSessionButton'
import { stateLabel } from '@/components/agents/PickSendPanel'
import { Hint } from '@/components/common/Hint'
import { useDict } from '@/i18n/useDict'
import type { PaneNode } from '@/layout/types'
import type { ReactElement } from 'react'
import { usePaneTitle } from './TabFace'

export function TabHint({
  pane,
  children,
}: {
  pane: PaneNode
  children: ReactElement
}): JSX.Element {
  const d = useDict()
  const title = usePaneTitle(pane)
  const session = usePaneAgentSession(pane)
  const folder = pane.kind === 'terminal' ? (session?.cwd ?? pane.cwd) : undefined
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
