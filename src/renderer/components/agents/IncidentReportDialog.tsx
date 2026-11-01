import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { fmt, useDict } from '@/lib/app/useDict'
import { useIncidentReportStore } from '@/stores/agents/incidentReportStore'

const DRAFT_DEBOUNCE_MS = 300

export function IncidentReportDialog(): JSX.Element {
  const d = useDict().privacy.incidents
  const ref = useIncidentReportStore((s) => s.ref)
  const close = useIncidentReportStore((s) => s.close)
  const [happened, setHappened] = useState('')
  const [expected, setExpected] = useState('')
  const [report, setReport] = useState<{ text: string; redacted: number } | null | undefined>()
  const [hint, setHint] = useState(false)
  const happenedId = useId()
  const expectedId = useId()

  useEffect(() => {
    if (ref === null) {
      setHappened('')
      setExpected('')
      setReport(undefined)
      setHint(false)
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      window.ostia.incidents
        .report(ref, { happened, expected })
        .then((next) => {
          if (!stale) setReport(next)
        })
        .catch(() => {
          if (!stale) setReport(null)
        })
    }, DRAFT_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [ref, happened, expected])

  const text = report?.text ?? ''
  return (
    <Dialog
      open={ref !== null}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent data-testid="incident-report-dialog" className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{d.dialogTitle}</DialogTitle>
          <DialogDescription>{d.dialogDesc}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          <label htmlFor={happenedId} className="text-fg-muted text-ui-xs">
            {d.happened}
          </label>
          <Textarea
            id={happenedId}
            rows={2}
            value={happened}
            maxLength={2000}
            className="text-fg text-ui-sm"
            onChange={(e) => setHappened(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={expectedId} className="text-fg-muted text-ui-xs">
            {d.expected}
          </label>
          <Textarea
            id={expectedId}
            rows={2}
            value={expected}
            maxLength={2000}
            className="text-fg text-ui-sm"
            onChange={(e) => setExpected(e.target.value)}
          />
        </div>
        {report === null ? (
          <p className="text-fg-muted text-ui-sm">{d.noReport}</p>
        ) : report === undefined ? null : (
          <pre
            data-testid="incident-report-text"
            className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-2 font-mono text-fg text-ui-xs"
          >
            {text}
          </pre>
        )}
        {report && report.redacted > 0 ? (
          <p className="text-fg-muted text-ui-xs">{fmt(d.redacted, { count: report.redacted })}</p>
        ) : null}
        {hint ? <p className="text-fg-muted text-ui-xs">{d.issueHint}</p> : null}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={close}>
            {d.cancel}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={text === ''}
            onClick={() => void navigator.clipboard.writeText(text)}
          >
            {d.copy}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={text === ''}
            onClick={() => void window.ostia.incidents.save()}
          >
            {d.save}
          </Button>
          <Button
            size="sm"
            disabled={text === ''}
            onClick={() => {
              setHint(true)
              void window.ostia.incidents.openIssue()
            }}
          >
            {d.openIssue}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
