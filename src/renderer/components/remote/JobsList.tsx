import type { RemoteJob } from '@shared/remote/remoteSetup'
import type { JSX } from 'react'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'

export function JobsList({
  jobs,
  onOpen,
  onStop,
}: {
  jobs: readonly RemoteJob[]
  onOpen: (pane: string) => void
  onStop: (pane: string) => void
}): JSX.Element {
  const d = useDict()
  return (
    <SettingsList label={d.remote.jobsLabel} empty={d.remote.jobsEmpty}>
      {jobs.map((job) => (
        <SettingsListRow
          key={job.pane}
          title={job.agent === 'shell' ? d.remote.jobAgentShell : job.agent}
          meta={d.remote.jobStates[job.state]}
          detail={<span className="font-mono">{job.folder}</span>}
          actions={
            <>
              <Button variant="outline" size="sm" onClick={() => onOpen(job.pane)}>
                {d.remote.jobOpen}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={job.state === 'exited'}
                onClick={() => onStop(job.pane)}
              >
                {d.remote.jobStop}
              </Button>
            </>
          }
        />
      ))}
    </SettingsList>
  )
}
