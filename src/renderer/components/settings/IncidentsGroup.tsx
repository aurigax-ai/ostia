import {
  INCIDENT_PERIODS,
  type IncidentPeriod,
  type IncidentSummary,
} from '@shared/agents/incident'
import { useEffect, useState } from 'react'
import { Segmented } from '@/components/common/Segmented'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SettingsGroup, SettingsSubgroup } from '@/components/settingsKit/SettingsGroup'
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
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24

export function IncidentsGroup(): JSX.Element {
  const d = useDict().privacy.incidents
  const telemetry = useSettingsStore((s) => s.privacy.telemetry)
  const showConsent = useTelemetryConsentStore((s) => s.show)
  const openReport = useIncidentReportStore((s) => s.open)
  const [items, setItems] = useState<IncidentSummary[]>([])
  const [period, setPeriod] = useState<IncidentPeriod>('24h')
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    let stale = false
    window.ostia.incidents
      .list(period)
      .then((next) => {
        if (!stale) setItems(next)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [period])
  const triggers = d.triggers as Record<string, string>
  const age = (ms: number): string => {
    const minutes = Math.floor(ms / MS_PER_MINUTE)
    if (minutes < 1) return d.justNow
    if (minutes < MINUTES_PER_HOUR) return fmt(d.ago, { minutes })
    const hours = Math.floor(minutes / MINUTES_PER_HOUR)
    return hours < HOURS_PER_DAY
      ? fmt(d.agoHours, { hours })
      : fmt(d.agoDays, { days: Math.floor(hours / HOURS_PER_DAY) })
  }
  return (
    <SettingsGroup title={d.title} desc={d.desc}>
      <ControlRow label={d.period}>
        <Segmented
          label={d.period}
          value={period}
          options={INCIDENT_PERIODS.map((value) => ({ value, label: d.periods[value] }))}
          onChange={setPeriod}
        />
      </ControlRow>
      <SettingsSubgroup title={d.recent} />
      <SettingsList label={d.recent} empty={d.none}>
        {items.map((item) => (
          <SettingsListRow
            key={item.ref}
            title={`${triggers[item.trigger] ?? d.triggers.other}${item.count > 1 ? ` ×${item.count}` : ''}`}
            meta={`${item.agent} · ${age(item.ageMs)}`}
            actions={
              <Button variant="outline" size="sm" onClick={() => openReport(item.ref)}>
                {d.report}
              </Button>
            }
          />
        ))}
      </SettingsList>
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
