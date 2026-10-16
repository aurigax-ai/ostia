import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty'
import { wakePane } from '@/lib/agents/hibernationScheduler'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import { useScheme } from '@/lib/theme/colorScheme'
import { MoonIcon, PlayIcon } from '@phosphor-icons/react'
import type { AgentResume } from '@shared/agents/agentResume'
import { useRef } from 'react'

export function HibernatedView({
  paneId,
  resume,
}: {
  paneId: string
  resume?: AgentResume
}): JSX.Element {
  const d = useDict()
  const wakeRef = useRef<HTMLButtonElement>(null)
  const { background, foreground } = useScheme('terminal').colors
  useSurfaceFocus(paneId, resume ? () => wakeRef.current : null)

  return (
    <div className="hibernated-view" data-hibernated="" style={{ background, color: foreground }}>
      <Empty className="h-full">
        <EmptyHeader>
          {resume ? (
            <EmptyTitle className="font-semibold text-ui-lg capitalize">{resume.agent}</EmptyTitle>
          ) : null}
          <EmptyDescription className="flex items-center gap-1.5 text-ui-base">
            <MoonIcon size={16} className="shrink-0" aria-hidden />
            {d.pane.hibernated}
          </EmptyDescription>
        </EmptyHeader>
        {resume ? (
          <EmptyContent>
            <Button
              ref={wakeRef}
              variant="outline"
              size="sm"
              onClick={() => wakePane(paneId, undefined, true)}
            >
              <PlayIcon data-icon="inline-start" aria-hidden />
              {fmt(d.pane.resume, { agent: resume.agent })}
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    </div>
  )
}
