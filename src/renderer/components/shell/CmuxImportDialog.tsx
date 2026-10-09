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
import { useCmuxImportStore } from '@/stores/cmuxImportStore'
import type { CmuxImportReport, CmuxLossEntry } from '@shared/cmuxSession'
import type { Dict } from '@shared/dict'
import { MAX_PANES, MAX_WORKSPACES } from '@shared/workspaceLimits'
import { useId } from 'react'

function lossLine(d: Dict, entry: CmuxLossEntry): string {
  const t = d.cmuxImport
  const where = entry.pane
    ? fmt(t.inPane, { workspace: entry.workspace, pane: entry.pane })
    : entry.workspace
  const what = fmt(t.losses[entry.loss], { detail: entry.detail ?? '', max: MAX_PANES })
  return fmt(t.lossLine, { where, what })
}

function ReportBody({ d, report }: { d: Dict; report: CmuxImportReport }): JSX.Element {
  const t = d.cmuxImport
  return (
    <div className="flex max-h-80 flex-col gap-3 overflow-auto text-ui-sm">
      <section className="flex flex-col gap-1">
        <div className="font-medium text-fg text-ui-base">
          {fmt(t.imported, { n: report.imported.length })}
        </div>
        {report.imported.length === 0 ? (
          <p className="text-fg-muted">{t.nothing}</p>
        ) : (
          <ul aria-label={t.importedList} className="flex flex-col gap-1 text-fg">
            {report.imported.map((w) => (
              <li key={w.workspaceId}>{fmt(t.importedItem, { name: w.name, n: w.panes })}</li>
            ))}
          </ul>
        )}
      </section>
      {report.skipped.length > 0 ? (
        <section className="flex flex-col gap-1">
          <div className="font-medium text-fg text-ui-base">{t.skipped}</div>
          <ul aria-label={t.skipped} className="flex flex-col gap-1 text-fg-muted">
            {report.skipped.map((s, i) => (
              <li key={`${s.window}-${s.name}-${i}`}>
                {fmt(t.reasons[s.reason], { name: s.name, max: MAX_WORKSPACES })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {report.imported.length > 0 ? (
        <section className="flex flex-col gap-1">
          <div className="font-medium text-fg text-ui-base">{t.notCarried}</div>
          <p className="text-fg-muted">{t.programs}</p>
          {report.notCarried.length > 0 ? (
            <ul aria-label={t.notCarried} className="flex flex-col gap-1 text-fg-muted">
              {report.notCarried.map((entry, i) => (
                <li key={`${entry.workspace}-${entry.pane ?? ''}-${entry.loss}-${i}`}>
                  {lossLine(d, entry)}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

export function CmuxImportDialog(): JSX.Element {
  const d = useDict()
  const outcome = useCmuxImportStore((s) => s.outcome)
  const dismiss = useCmuxImportStore((s) => s.dismiss)
  const actionId = useId()
  const t = d.cmuxImport
  const report = outcome && 'report' in outcome ? outcome.report : null
  const error = outcome && 'error' in outcome ? outcome : null

  return (
    <AlertDialog
      open={outcome !== null}
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
    >
      <AlertDialogContent initialFocus={() => document.getElementById(actionId)}>
        <AlertDialogHeader>
          <AlertDialogTitle>{error ? t.failedTitle : t.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {error
              ? fmt(t.errors[error.error], { path: error.path ?? t.defaultPath })
              : fmt(t.from, { path: report?.path ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {report ? <ReportBody d={d} report={report} /> : null}
        <AlertDialogFooter>
          <AlertDialogAction id={actionId} size="sm" onClick={dismiss}>
            {t.ok}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
