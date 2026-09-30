import { fmt, useDict } from '../i18n/useDict'
import { SANDBOX_FEATURE, useSandboxStore } from '../stores/sandboxStore'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'

export function SandboxRequirementsDialog(): JSX.Element {
  const d = useDict()
  const blocked = useSandboxStore((s) => s.blocked)
  const dismiss = useSandboxStore((s) => s.dismissBlocked)
  const report = blocked?.report
  const packages = report?.hint.packages.join(', ') ?? ''
  const command = report?.hint.command ?? null

  return (
    <Dialog
      open={blocked !== null}
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{d.sandbox.requirementsTitle}</DialogTitle>
          <DialogDescription>{fmt(d.sandbox.requirementsBody, { packages })}</DialogDescription>
        </DialogHeader>
        {!report?.canInstall && command ? (
          <pre className="overflow-auto rounded-sm border border-line p-2 font-mono text-fg text-ui-sm">
            {command}
          </pre>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={dismiss}>
            {d.sandbox.requirementsClose}
          </Button>
          {report?.canInstall && blocked ? (
            <Button
              size="sm"
              onClick={() => {
                void window.pine.system.installRequirements(SANDBOX_FEATURE, blocked.workspaceId)
                dismiss()
              }}
            >
              {d.sandbox.install}
            </Button>
          ) : command ? (
            <Button size="sm" onClick={() => void navigator.clipboard?.writeText(command)}>
              {d.sandbox.copyCommand}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
