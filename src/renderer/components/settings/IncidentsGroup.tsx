import type { IncidentSummary } from '@shared/agents/incident'
import { useEffect, useState } from 'react'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { fmt, useDict } from '@/lib/app/useDict'
import { useIncidentReportStore } from '@/stores/agents/incidentReportStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useTelemetryConsentStore } from '@/stores/app/telemetryConsentStore'

const MS_PER_MINUTE = 60_000

export function IncidentsGroup(): JSX.Element {
  const d = useDict().privacy.incidents
  const telemetry = useSettingsStore((s) => s.privacy.telemetry)
  const showConsent = useTelemetryConsentStore((s) => s.show)
  const openReport = useIncidentReportStore((s) => s.open)
  const [items, setItems] = useState<IncidentSummary[]>([])
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    let stale = false
    window.ostia.incidents
      .list()
      .then((next) => {
        if (!stale) setItems(next)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [])
  const triggers = d.triggers as Record<string, string>
  const age = (ms: number): string =>
    ms < MS_PER_MINUTE ? d.justNow : fmt(d.ago, { minutes: Math.floor(ms / MS_PER_MINUTE) })
  return (
    <SettingsGroup title={d.title} desc={d.desc}>
      <SettingsList label={d.recent} empty={d.none}>
        {items.map((item) => (
          <SettingsListRow
            key={item.ref}
            title={triggers[item.trigger] ?? d.triggers.other}
            meta={`${item.agent} · ${age(item.ageMs)}`}
            actions={
              <Button variant="outline" size="sm" onClick={() => openReport(item.ref)}>
                {d.report}
              </Button>
            }
          />
        ))}
      </SettingsList>
      {items.length > 0 ? (
        <p className="py-1 text-fg-muted text-ui-sm">
          {fmt(d.totals, { count: items.length, panes: new Set(items.map((i) => i.ref)).size })}
        </p>
      ) : null}
      <ControlRow label={d.share} desc={d.shareDesc}>
        <Button variant="outline" size="sm" onClick={() => showConsent(telemetry)}>
          {d.openTelemetry}
        </Button>
      </ControlRow>
      <ControlRow label={d.clearRow} desc={d.clearDesc}>
        <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
          {d.clear}
        </Button>
      </ControlRow>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{d.clearTitle}</DialogTitle>
            <DialogDescription>{d.clearDesc}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {d.cancel}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                void window.ostia.incidents.clear().then(() => setItems([]))
                setConfirming(false)
              }}
            >
              {d.clearConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  )
}
