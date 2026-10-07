import { useEffect, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { useSettingsStore } from '../stores/settingsStore'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Label } from './ui/label'

function Section({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <h3 className="font-medium text-fg text-ui-sm">{title}</h3>
      <p className="text-fg-muted text-ui-sm">{body}</p>
    </div>
  )
}

function Choice({
  id,
  label,
  desc,
  checked,
  onChange,
}: {
  id: string
  label: string
  desc: string
  checked: boolean
  onChange: (next: boolean) => void
}): JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        className="mt-0.5"
      />
      <Label htmlFor={id} className="flex flex-col items-start gap-0.5 font-normal">
        <span className="font-medium text-fg text-ui-sm">{label}</span>
        <span className="text-fg-muted text-ui-xs">{desc}</span>
      </Label>
    </div>
  )
}

export function TelemetryConsentDialog(): JSX.Element | null {
  const d = useDict()
  const setTelemetry = useSettingsStore((s) => s.setTelemetry)
  const [open, setOpen] = useState(false)
  const [errors, setErrors] = useState(true)
  const [usage, setUsage] = useState(true)

  useEffect(() => {
    let stale = false
    window.ostia.telemetry
      .state()
      .then((state) => {
        if (!stale && state.available && !state.asked) setOpen(true)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [])

  const answer = async (share: boolean): Promise<void> => {
    setOpen(false)
    await setTelemetry({ errors: share && errors, usage: share && usage })
    await window.ostia.telemetry.consented()
  }

  if (!open) return null
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void answer(false)
      }}
    >
      <DialogContent showCloseButton={false} data-testid="telemetry-consent-dialog">
        <DialogHeader>
          <DialogTitle>{d.privacy.consentTitle}</DialogTitle>
          <DialogDescription>{d.privacy.consentBody}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Choice
            id="telemetry-consent-errors"
            label={d.privacy.errorReports}
            desc={d.privacy.errorReportsDesc}
            checked={errors}
            onChange={setErrors}
          />
          <Choice
            id="telemetry-consent-usage"
            label={d.privacy.usageData}
            desc={d.privacy.usageDataDesc}
            checked={usage}
            onChange={setUsage}
          />
          <Section title={d.privacy.consentCollected} body={d.privacy.consentCollectedBody} />
          <Section title={d.privacy.consentNever} body={d.privacy.consentNeverBody} />
          <Section title={d.privacy.consentWhere} body={d.privacy.consentWhereBody} />
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => void answer(false)}>
            {d.privacy.consentDecline}
          </Button>
          <Button size="sm" disabled={!errors && !usage} onClick={() => void answer(true)}>
            {d.privacy.consentShare}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
