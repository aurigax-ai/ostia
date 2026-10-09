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
import { useActionConfirmStore } from '@/stores/actionConfirmStore'

export function ActionConfirmDialog(): JSX.Element {
  const d = useDict()
  const pending = useActionConfirmStore((s) => s.pending)
  const answer = useActionConfirmStore((s) => s.answer)

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) answer('cancel')
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {fmt(d.actions.confirmTitle, { title: pending?.action.title ?? '' })}
          </DialogTitle>
          <DialogDescription>
            {pending?.action.origin
              ? fmt(d.views.confirmBody, { file: pending.action.origin })
              : d.actions.confirmBody}
          </DialogDescription>
        </DialogHeader>
        <dl className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <dt className="text-fg-muted text-ui-xs">{d.actions.command}</dt>
            <dd className="font-mono text-fg text-ui-sm">{pending?.action.command}</dd>
          </div>
          {pending?.args ? (
            <div className="flex flex-col gap-0.5">
              <dt className="text-fg-muted text-ui-xs">{d.actions.args}</dt>
              <dd>
                <pre className="max-h-48 overflow-auto rounded-sm border border-line p-2 font-mono text-fg text-ui-xs">
                  {JSON.stringify(pending.args, null, 2)}
                </pre>
              </dd>
            </div>
          ) : null}
        </dl>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => answer('cancel')}>
            {d.actions.cancel}
          </Button>
          <Button variant="outline" size="sm" onClick={() => answer('trust')}>
            {d.actions.runAndTrust}
          </Button>
          <Button size="sm" onClick={() => answer('once')}>
            {d.actions.runOnce}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
