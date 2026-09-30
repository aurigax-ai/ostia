import { RobotIcon } from '@phosphor-icons/react'
import { resumeCommand } from '@shared/agentResume'
import { useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import type { PaneNode } from '../layout/types'
import { agentSession } from '../lib/agentSession'
import { formatDuration } from '../lib/promptChips'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { IconButton } from './IconButton'
import { stateLabel } from './PickSendPanel'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

const CLOCK_MS = 1000

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => clearInterval(timer)
  }, [enabled])
  return now
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-fg-muted text-ui-xs">{label}</dt>
      <dd className={mono ? 'truncate font-mono text-ui-xs' : 'truncate text-ui-sm'}>{value}</dd>
    </div>
  )
}

export function AgentSessionButton({ pane }: { pane: PaneNode }): JSX.Element | null {
  const d = useDict()
  const [open, setOpen] = useState(false)
  const running = useBlocksStore((s) => {
    const id = s.running[pane.id]
    return id ? s.byPane[pane.id]?.find((b) => b.id === id) : undefined
  })
  const attention = useAttentionStore((s) => s.byPane[pane.id])
  const now = useNow(open)
  const session = agentSession(pane, running, attention)
  if (!session) return null

  const agentName = d.agentSession[session.agent]
  const label = session.title
    ? `${fmt(d.agentSession.label, { agent: agentName })}: ${session.title}`
    : fmt(d.agentSession.label, { agent: agentName })
  const copy = (text: string): void => void navigator.clipboard.writeText(text)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className="agent-session">
        <PopoverTrigger render={<IconButton icon={RobotIcon} label={label} />} />
        <span
          className={`dot agent-session-dot ${session.state === 'none' ? '' : session.state}`}
          aria-hidden
        />
      </span>
      <PopoverContent align="end" className="w-80">
        <div className="flex items-center gap-2">
          <span
            className={`dot ${session.state === 'none' ? '' : session.state}`}
            role="img"
            aria-label={stateLabel(d, session.state)}
          />
          <span className="font-medium text-ui-sm">{agentName}</span>
          <span className="text-fg-muted text-ui-xs">{stateLabel(d, session.state)}</span>
        </div>
        {session.message ? <p className="text-fg-muted text-ui-sm">{session.message}</p> : null}
        <dl className="flex flex-col gap-1.5">
          {session.title ? <Field label={d.agentSession.title} value={session.title} /> : null}
          {session.sessionId ? (
            <Field label={d.agentSession.id} value={session.sessionId} mono />
          ) : null}
          <Field label={d.agentSession.running} value={formatDuration(now - session.startedAt)} />
          {session.cwd ? <Field label={d.agentSession.folder} value={session.cwd} mono /> : null}
          <Field label={d.agentSession.command} value={session.command} mono />
        </dl>
        {session.sessionId ? (
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => copy(session.sessionId ?? '')}>
              {d.agentSession.copyId}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                copy(resumeCommand({ agent: session.agent, id: session.sessionId ?? '' }))
              }
            >
              {d.agentSession.copyResume}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
