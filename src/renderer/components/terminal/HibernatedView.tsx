import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { wakePane } from '@/lib/agents/hibernationScheduler'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import {
  type ReadOnlyTerminal,
  mountReadOnlyTerminal,
  useReadOnlyTerminalBackground,
  useReadOnlyTerminalFont,
} from '@/lib/terminal/readOnlyTerminal'
import { MoonIcon, PlayIcon } from '@phosphor-icons/react'
import type { AgentResume } from '@shared/agents/agentResume'
import { useEffect, useRef } from 'react'

export function HibernatedView({
  paneId,
  resume,
}: {
  paneId: string
  resume?: AgentResume
}): JSX.Element {
  const d = useDict()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<ReadOnlyTerminal | null>(null)
  const background = useReadOnlyTerminalBackground(termRef)
  useReadOnlyTerminalFont(termRef)
  useSurfaceFocus(paneId, () => termRef.current?.textarea ?? null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const { term, dispose } = mountReadOnlyTerminal(host)
    termRef.current = term
    let live = true
    void window.ostia.pty.stashed(paneId).then((screen) => {
      if (live && screen) term.write(screen)
    })
    return () => {
      live = false
      termRef.current = null
      dispose()
    }
  }, [paneId])

  return (
    <div className="hibernated-view" data-hibernated="">
      <div ref={hostRef} className="xterm-host hibernated-screen" style={{ background }} />
      <div className="hibernated-mark">
        <Badge variant="outline" className="bg-bg text-fg-muted text-ui-xs">
          <MoonIcon aria-hidden />
          {d.pane.asleep}
        </Badge>
        {resume ? (
          <Button variant="outline" size="sm" onClick={() => wakePane(paneId)}>
            <PlayIcon data-icon="inline-start" aria-hidden />
            {fmt(d.pane.resume, { agent: resume.agent })}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
