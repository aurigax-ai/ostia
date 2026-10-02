import { fmt, useDict } from '../i18n/useDict'
import { useSandboxStore } from '../stores/sandboxStore'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'

export function SandboxFolderDialog(): JSX.Element {
  const d = useDict()
  const refused = useSandboxStore((s) => s.refusedFolder)
  const dismiss = useSandboxStore((s) => s.dismissRefusedFolder)
  return (
    <Dialog
      open={refused !== null}
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{d.sandbox.folderTitle}</DialogTitle>
          <DialogDescription>
            {refused
              ? fmt(d.sandbox.folderRefused, {
                  reason: fmt(d.sandbox.folderReasons[refused.reason], { folder: refused.folder }),
                  advice: d.sandbox.folderAdvice,
                })
              : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" onClick={dismiss}>
            {d.sandbox.folderClose}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
