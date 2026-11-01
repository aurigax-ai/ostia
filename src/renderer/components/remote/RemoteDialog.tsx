import type { RemoteChoice, SetupStep } from '@shared/remote/remoteSetup'
import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useDict } from '@/lib/app/useDict'
import { RemoteForm } from './RemoteForm'
import { RemoteSetup } from './RemoteSetup'

export function RemoteDialog({
  open,
  hosts,
  choice,
  steps,
  onChange,
  onSetUp,
  onRetry,
  onCheck,
  onClose,
}: {
  open: boolean
  hosts: readonly string[]
  choice: RemoteChoice
  steps: readonly SetupStep[] | null
  onChange: (next: RemoteChoice) => void
  onSetUp: () => void
  onRetry: () => void
  onCheck: () => void
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(90vw,36rem)] max-w-none sm:max-w-none"
      >
        <DialogHeader>
          <DialogTitle>{d.remote.title}</DialogTitle>
          <DialogDescription>{d.remote.desc}</DialogDescription>
        </DialogHeader>
        {steps ? (
          <RemoteSetup steps={steps} onRetry={onRetry} onCheck={onCheck} />
        ) : (
          <RemoteForm hosts={hosts} value={choice} onChange={onChange} />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {steps ? d.remote.close : d.remote.cancel}
          </Button>
          {steps ? null : (
            <Button disabled={choice.host === '' || choice.folder.trim() === ''} onClick={onSetUp}>
              {d.remote.setUp}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
