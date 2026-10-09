import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useDict } from '@/i18n/useDict'
import {
  TELEMETRY_CATEGORIES,
  type TelemetryCategory,
  type TelemetryReport,
  type TelemetryReports,
  reportCategories,
} from '@shared/telemetry'
import { useEffect, useState } from 'react'
import { SelectField } from './SettingsPanel'

type Filter = TelemetryCategory | 'all'

function ReportList({
  title,
  reports,
}: {
  title: string
  reports: TelemetryReport[]
}): JSX.Element {
  const d = useDict()
  return (
    <section aria-label={title} className="flex min-h-0 flex-col gap-1">
      <h3 className="font-medium text-fg text-ui-sm">{title}</h3>
      {reports.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.privacy.reportsNone}</p>
      ) : (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-2 font-mono text-fg text-ui-xs">
          {reports.map((report) => JSON.stringify(report, null, 2)).join('\n\n')}
        </pre>
      )}
    </section>
  )
}

export function TelemetryReportsDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const [reports, setReports] = useState<TelemetryReports | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  useEffect(() => {
    if (!open) return
    let stale = false
    window.ostia.telemetry
      .reports()
      .then((next) => {
        if (!stale) setReports(next)
      })
      .catch(() => {
        if (!stale) setReports({ queued: [], sent: [] })
      })
    return () => {
      stale = true
    }
  }, [open])
  const keep = (report: TelemetryReport): boolean =>
    filter === 'all' || reportCategories(report).includes(filter)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent data-testid="telemetry-reports-dialog">
        <DialogHeader>
          <DialogTitle>{d.privacy.reportsTitle}</DialogTitle>
          <DialogDescription>{d.privacy.reportsDesc}</DialogDescription>
        </DialogHeader>
        <SelectField
          value={filter}
          onChange={(next) => setFilter(next as Filter)}
          label={d.privacy.reportsFilter}
          options={[
            { value: 'all', label: d.privacy.reportsAll },
            ...TELEMETRY_CATEGORIES.map((c) => ({
              value: c,
              label: d.privacy.categories[c].label,
            })),
          ]}
        />
        {reports ? (
          <div className="flex flex-col gap-3">
            <ReportList title={d.privacy.reportsQueued} reports={reports.queued.filter(keep)} />
            <ReportList title={d.privacy.reportsSent} reports={reports.sent.filter(keep)} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
