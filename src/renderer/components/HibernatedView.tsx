import { PlayIcon } from '@phosphor-icons/react'
import { type AgentResume, resumeCommand } from '@shared/agentResume'
import { fmt, useDict } from '../i18n/useDict'
import { wakePane } from '../lib/hibernationScheduler'
import { Button } from './ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty'

export function HibernatedView({
  paneId,
  resume,
}: {
  paneId: string
  resume?: AgentResume
}): JSX.Element {
  const d = useDict()
  const command = resume ? resumeCommand(resume) : ''
  return (
    <Empty className="hibernated-view" data-hibernated="">
      <EmptyHeader>
        <EmptyTitle className="font-semibold text-fg text-ui-lg">
          {d.pane.hibernatedTitle}
        </EmptyTitle>
        <EmptyDescription className="text-ui-base">
          {fmt(d.pane.hibernatedBody, { command })}
        </EmptyDescription>
      </EmptyHeader>
      {resume ? (
        <Button variant="outline" size="sm" onClick={() => wakePane(paneId)}>
          <PlayIcon data-icon="inline-start" aria-hidden />
          {fmt(d.pane.resume, { agent: resume.agent })}
        </Button>
      ) : null}
    </Empty>
  )
}
