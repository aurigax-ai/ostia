import { MoonIcon, PlayIcon } from '@phosphor-icons/react'
import type { AgentResume } from '@shared/agents/agentResume'
import { type JSX, useRef } from 'react'
import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import { wakePane } from '@/lib/agents/hibernationScheduler'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import { useScheme } from '@/lib/theme/colorScheme'

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
      <EmptyState
        variant="surface"
        className="h-full"
        title={resume ? resume.agent : undefined}
        titleClassName="capitalize text-inherit"
        desc={
          <>
            <MoonIcon size={16} className="shrink-0" aria-hidden />
            {d.pane.hibernated}
          </>
        }
        descClassName="flex items-center gap-1.5"
        actions={
          resume ? (
            <Button
              ref={wakeRef}
              variant="outline"
              size="sm"
              onClick={() => wakePane(paneId, undefined, true)}
            >
              <PlayIcon data-icon="inline-start" aria-hidden />
              {fmt(d.pane.resume, { agent: resume.agent })}
            </Button>
          ) : null
        }
      />
    </div>
  )
}
