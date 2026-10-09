import { TextLink } from '@/components/common/TextLink'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { useDict } from '@/i18n/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useTelemetryConsentStore } from '@/stores/app/telemetryConsentStore'
import {
  DEFAULT_TELEMETRY_SETTINGS,
  TELEMETRY_CATEGORIES,
  type TelemetryCategory,
  type TelemetrySettings,
  anyTelemetryOn,
} from '@shared/privacy/telemetry'
import { useEffect, useState } from 'react'

export function CategoryDetails({ category }: { category: TelemetryCategory }): JSX.Element {
  const d = useDict()
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="text-fg-muted text-ui-xs underline-offset-2 hover:text-fg hover:underline focus-visible:text-fg focus-visible:underline"
        aria-label={`${open ? d.privacy.hideDetails : d.privacy.showDetails}: ${d.privacy.categories[category].label}`}
      >
        {open ? d.privacy.hideDetails : d.privacy.showDetails}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-1 text-fg-muted text-ui-xs">{d.privacy.categories[category].details}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

function CategoryChoice({
  category,
  checked,
  onChange,
}: {
  category: TelemetryCategory
  checked: boolean
  onChange: (next: boolean) => void
}): JSX.Element {
  const d = useDict()
  const id = `telemetry-consent-${category}`
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-col items-start gap-0.5">
        <Label htmlFor={id} className="flex flex-col items-start gap-0.5 font-normal">
          <span className="font-medium text-fg text-ui-sm">
            {d.privacy.categories[category].label}
          </span>
          <span className="text-fg-muted text-ui-xs">{d.privacy.categories[category].sends}</span>
        </Label>
        <CategoryDetails category={category} />
      </div>
    </div>
  )
}

export function TelemetryConsentDialog(): JSX.Element | null {
  const d = useDict()
  const setTelemetry = useSettingsStore((s) => s.setTelemetry)
  const open = useTelemetryConsentStore((s) => s.open)
  const initial = useTelemetryConsentStore((s) => s.initial)
  const show = useTelemetryConsentStore((s) => s.show)
  const close = useTelemetryConsentStore((s) => s.close)
  const [choice, setChoice] = useState<TelemetrySettings>(DEFAULT_TELEMETRY_SETTINGS)

  useEffect(() => {
    if (open) setChoice(initial)
  }, [open, initial])

  useEffect(() => {
    let stale = false
    window.ostia.telemetry
      .state()
      .then((state) => {
        if (!stale && state.available && !state.asked) show()
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [show])

  const answer = async (share: boolean): Promise<void> => {
    close()
    await setTelemetry(share ? choice : DEFAULT_TELEMETRY_SETTINGS)
    await window.ostia.telemetry.consented()
  }

  if (!open) return null
  const all = Object.fromEntries(TELEMETRY_CATEGORIES.map((c) => [c, true])) as TelemetrySettings
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
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
          {TELEMETRY_CATEGORIES.map((category) => (
            <CategoryChoice
              key={category}
              category={category}
              checked={choice[category]}
              onChange={(next) => setChoice((prev) => ({ ...prev, [category]: next }))}
            />
          ))}
          <div className="flex flex-col gap-0.5 border-line border-t pt-3">
            <h3 className="font-medium text-fg text-ui-sm">
              {d.privacy.installContext}
              <span className="ml-1 font-normal text-fg-muted">
                ({d.privacy.alwaysIncluded.toLowerCase()})
              </span>
            </h3>
            <p className="text-fg-muted text-ui-xs">{d.privacy.installContextSends}</p>
          </div>
        </div>
        <DialogFooter className="items-center">
          <TextLink className="mr-auto text-ui-sm" onClick={() => setChoice(all)}>
            {d.privacy.consentSelectAll}
          </TextLink>
          <Button variant="ghost" size="sm" onClick={() => void answer(false)}>
            {d.privacy.consentDecline}
          </Button>
          <Button size="sm" disabled={!anyTelemetryOn(choice)} onClick={() => void answer(true)}>
            {d.privacy.consentShare}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
