import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { fmt, useDict } from '@/i18n/useDict'
import { useRemoteFoldersStore } from '@/stores/files/remoteFoldersStore'

export function RemoteFolderDialog(): JSX.Element {
  const d = useDict()
  const pending = useRemoteFoldersStore((s) => s.pending)
  const answer = useRemoteFoldersStore((s) => s.answer)
  const ask = pending?.ask

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) answer(false)
      }}
    >
      <DialogContent showCloseButton={false} data-testid="remote-folder-dialog">
        <DialogHeader>
          <DialogTitle>{d.remoteFolders.confirmTitle}</DialogTitle>
          <DialogDescription>
            {fmt(d.remoteFolders.confirmBody, { extension: ask?.extName ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <dl className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <dt className="text-fg-muted text-ui-xs">{d.remoteFolders.host}</dt>
            <dd className="break-all font-mono text-fg text-ui-sm">{ask?.host}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-fg-muted text-ui-xs">{d.remoteFolders.folder}</dt>
            <dd className="break-all font-mono text-fg text-ui-sm">{ask?.path}</dd>
          </div>
        </dl>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => answer(false)}>
            {d.remoteFolders.cancel}
          </Button>
          <Button size="sm" onClick={() => answer(true)}>
            {d.remoteFolders.open}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
