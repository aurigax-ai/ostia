import { IconButton } from '@/components/common/IconButton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { fmt, useDict } from '@/i18n/useDict'
import type { PaneNode } from '@/layout/types'
import { type AgentSession, agentSession } from '@/lib/agentSession'
import { commandAgent } from '@/lib/hibernation'
import { formatDuration } from '@/lib/promptChips'
import { useAttentionStore } from '@/stores/attentionStore'
import { useBlocksStore } from '@/stores/blocksStore'
import { RobotIcon } from '@phosphor-icons/react'
import { type AgentResume, resumeCommand } from '@shared/agentResume'
import { type AgentSessionInfo, formatTokens } from '@shared/agentSessionInfo'
import { useEffect, useState } from 'react'
import { stateLabel } from './PickSendPanel'

const CLOCK_MS = 1000
const INFO_POLL_MS = 3000

function useSessionInfo(resume: AgentResume | null, enabled: boolean): AgentSessionInfo | null {
  const [info, setInfo] = useState<AgentSessionInfo | null>(null)
  const agent = resume?.agent
  const id = resume?.id
  useEffect(() => {
    if (!enabled || !agent || !id) return
    let alive = true
    const load = (): void => {
      void window.ostia.agentSession.info({ agent, id }).then((next) => {
        if (alive) setInfo(next)
      })
    }
    load()
    const timer = setInterval(load, INFO_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [enabled, agent, id])
  return info
}

function contextLabel(info: AgentSessionInfo): string | null {
  if (info.contextTokens === null) return null
  const used = formatTokens(info.contextTokens)
  if (!info.contextWindow) return used
  const percent = Math.round((info.contextTokens / info.contextWindow) * 100)
  return `${used} / ${formatTokens(info.contextWindow)} (${percent}%)`
}

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

export function usePaneAgentSession(pane: PaneNode): AgentSession | null {
  const running = useBlocksStore((s) => {
    const id = s.running[pane.id]
    return id ? s.byPane[pane.id]?.find((b) => b.id === id) : undefined
  })
  const attention = useAttentionStore((s) => s.byPane[pane.id])
  const agent = useBlocksStore((s) => {
    const blockId = s.running[pane.id]
    if (!blockId) return null
    const marked = s.agentBlocks[pane.id]
    return marked?.blockId === blockId ? marked.agent : null
  })
  return agentSession(
    pane,
    running,
    attention,
    running ? (commandAgent(running.command) ?? agent) : null,
  )
}

export function AgentSessionButton({ pane }: { pane: PaneNode }): JSX.Element | null {
  const d = useDict()
  const [open, setOpen] = useState(false)
  const now = useNow(open)
  const session = usePaneAgentSession(pane)
  const info = useSessionInfo(
    session?.sessionId ? { agent: session.agent, id: session.sessionId } : null,
    open,
  )
  if (!session) return null
  const title = info?.title ?? session.title
  const context = info ? contextLabel(info) : null
  const facts = [
    { label: d.agentSession.model, value: info?.model },
    { label: d.agentSession.context, value: context },
    { label: d.agentSession.branch, value: info?.branch },
    { label: d.agentSession.effort, value: info?.effort },
    { label: d.agentSession.mode, value: info?.mode },
    { label: d.agentSession.version, value: info?.version },
  ].filter((f): f is { label: string; value: string } => Boolean(f.value))

  const agentName = d.agentSession[session.agent]
  const label = [
    title
      ? `${fmt(d.agentSession.label, { agent: agentName })}: ${title}`
      : fmt(d.agentSession.label, { agent: agentName }),
    session.sessionId ? d.agentSession.resumable : d.agentSession.notResumable,
  ].join(' · ')
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
          <Badge variant="outline" className="ml-auto text-ui-xs">
            {session.sessionId ? d.agentSession.resumable : d.agentSession.notResumable}
          </Badge>
        </div>
        {session.sessionId ? null : (
          <p className="text-fg-muted text-ui-xs">{d.agentSession.notResumableHint}</p>
        )}
        {title ? <p className="font-medium text-fg text-ui-base">{title}</p> : null}
        {session.message ? <p className="text-fg-muted text-ui-sm">{session.message}</p> : null}
        {facts.length > 0 ? (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {facts.map((f) => (
              <Field key={f.label} label={f.label} value={f.value} />
            ))}
          </dl>
        ) : null}
        <dl className="flex flex-col gap-1.5">
          {session.sessionId ? (
            <Field label={d.agentSession.id} value={session.sessionId} mono />
          ) : null}
          <Field label={d.agentSession.running} value={formatDuration(now - session.startedAt)} />
          {(info?.cwd ?? session.cwd) ? (
            <Field label={d.agentSession.folder} value={info?.cwd ?? session.cwd ?? ''} mono />
          ) : null}
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
