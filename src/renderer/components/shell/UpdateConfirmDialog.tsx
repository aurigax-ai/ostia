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
import { useUpdateStore } from '@/stores/app/updateStore'

export function UpdateConfirmDialog(): JSX.Element {
  const d = useDict()
  const open = useUpdateStore((s) => s.confirming)
  const command = useUpdateStore((s) => s.updateCommand)
  const method = useUpdateStore((s) => s.method)
  const cancel = useUpdateStore((s) => s.cancelUpdate)
  const confirm = useUpdateStore((s) => s.confirmUpdate)
  const tool = method === 'apt' ? d.update.tools.apt : d.update.tools.brew
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) cancel()
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{fmt(d.update.confirmTitle, { tool })}</DialogTitle>
          <DialogDescription>{d.update.confirmBody}</DialogDescription>
        </DialogHeader>
        <dl className="flex flex-col gap-0.5">
          <dt className="text-fg-muted text-ui-xs">{d.actions.command}</dt>
          <dd className="font-mono text-fg text-ui-sm">{command}</dd>
        </dl>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={cancel}>
            {d.update.confirmCancel}
          </Button>
          <Button size="sm" onClick={() => void confirm()}>
            {d.update.confirmRun}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
