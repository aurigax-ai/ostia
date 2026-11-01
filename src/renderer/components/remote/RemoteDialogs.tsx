import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { fmt, useDict } from '@/lib/app/useDict'
import { useRemoteStore } from '@/lib/remote/remoteStore'
import { JobsList } from './JobsList'
import { RemoteDialog } from './RemoteDialog'

export function RemoteDialogs(): JSX.Element {
  const d = useDict()
  const s = useRemoteStore()
  const jobs = s.jobs !== 'loading' ? s.jobs : null
  return (
    <>
      <RemoteDialog
        open={s.mode === 'new'}
        hosts={s.hosts}
        choice={s.choice}
        steps={s.steps}
        onChange={s.change}
        onSetUp={s.setUp}
        onRetry={s.retry}
        onCheck={s.check}
        onClose={s.close}
      />
      <Dialog open={s.mode === 'jobs'} onOpenChange={(open) => !open && s.close()}>
        <DialogContent
          showCloseButton={false}
          className="w-[min(90vw,36rem)] max-w-none sm:max-w-none"
        >
          <DialogHeader>
            <DialogTitle>{fmt(d.remote.jobsTitle, { host: jobs?.host ?? '' })}</DialogTitle>
          </DialogHeader>
          {s.jobs === 'loading' ? null : jobs ? (
            <JobsList jobs={jobs.jobs} onOpen={s.open} onStop={s.stop} />
          ) : (
            <p className="text-fg-muted text-ui-sm">{d.remote.notRemote}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={s.close}>
              {d.remote.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
