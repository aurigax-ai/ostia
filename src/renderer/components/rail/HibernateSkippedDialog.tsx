import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { fmt, useDict } from '@/i18n/useDict'
import { useHibernateSkippedStore } from '@/stores/hibernateSkippedStore'
import { AGENT_BUSY_REASONS } from '@shared/agentWork'

export function HibernateSkippedDialog(): JSX.Element {
  const d = useDict()
  const skipped = useHibernateSkippedStore((s) => s.skipped)
  const dismiss = useHibernateSkippedStore((s) => s.dismiss)
  const reasons = AGENT_BUSY_REASONS.map((reason) => ({
    reason,
    n: skipped?.[reason] ?? 0,
  })).filter((r) => r.n > 0)
  const total = reasons.reduce((sum, r) => sum + r.n, 0)

  return (
    <AlertDialog
      open={skipped !== null}
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{fmt(d.hibernateSkipped.title, { n: total })}</AlertDialogTitle>
          <AlertDialogDescription>{d.hibernateSkipped.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul
          aria-label={d.hibernateSkipped.reasons}
          className="flex flex-col gap-1 text-fg text-ui-sm"
        >
          {reasons.map((r) => (
            <li key={r.reason}>{fmt(d.hibernateSkipped[r.reason], { n: r.n })}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogAction size="sm" onClick={dismiss}>
            {d.hibernateSkipped.ok}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
