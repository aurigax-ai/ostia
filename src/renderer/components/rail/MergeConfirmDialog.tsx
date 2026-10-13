import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { fmt, useDict } from '@/i18n/useDict'
import { useMergeConfirmStore } from '@/stores/workspaces/mergeConfirmStore'
import { TerminalWindowIcon } from '@phosphor-icons/react'
import { useId } from 'react'

export function MergeConfirmDialog(): JSX.Element {
  const d = useDict()
  const pending = useMergeConfirmStore((s) => s.pending)
  const answer = useMergeConfirmStore((s) => s.answer)
  const actionId = useId()
  const summary = pending?.summary
  const names = { source: summary?.source ?? '', target: summary?.target ?? '' }
  const counts = summary
    ? [
        { key: 'terminals', n: summary.terminals, text: d.merge.terminals },
        { key: 'editors', n: summary.editors, text: d.merge.editors },
        { key: 'browsers', n: summary.browsers, text: d.merge.browsers },
        { key: 'others', n: summary.others, text: d.merge.others },
      ].filter((c) => c.n > 0)
    : []

  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) answer(false)
      }}
    >
      <AlertDialogContent initialFocus={() => document.getElementById(actionId)}>
        <AlertDialogHeader>
          <AlertDialogTitle>{fmt(d.merge.title, names)}</AlertDialogTitle>
          <AlertDialogDescription>{fmt(d.merge.body, names)}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex max-h-64 flex-col gap-2 overflow-auto text-ui-sm">
          <div className="font-medium text-fg text-ui-base">{d.merge.moves}</div>
          {counts.length === 0 ? (
            <p className="text-fg-muted">{d.merge.noPanes}</p>
          ) : (
            <ul aria-label={d.merge.moves} className="flex flex-col gap-1 text-fg">
              {counts.map((c) => (
                <li key={c.key}>{fmt(c.text, { n: c.n })}</li>
              ))}
            </ul>
          )}
          {summary && summary.running.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {summary.running.map((r) => (
                <li key={r.paneId} className="flex min-w-0 items-center gap-2 text-fg-muted">
                  <TerminalWindowIcon size={14} className="shrink-0" aria-hidden />
                  <span className="truncate font-mono text-fg text-ui-sm">
                    {fmt(d.merge.keepsRunning, {
                      title: r.title,
                      command: r.command || d.closeConfirm.unknownCommand,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-fg-muted">{fmt(d.merge.closes, names)}</p>
          {summary && summary.browsers > 0 ? (
            <p className="text-fg-muted">{d.merge.browserReload}</p>
          ) : null}
          {summary?.chat ? <p className="text-fg-muted">{fmt(d.merge.chat, names)}</p> : null}
          {summary?.sandbox ? <p className="text-fg-muted">{fmt(d.merge.sandbox, names)}</p> : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel size="sm">{d.merge.cancel}</AlertDialogCancel>
          <AlertDialogAction id={actionId} size="sm" onClick={() => answer(true)}>
            {d.merge.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
