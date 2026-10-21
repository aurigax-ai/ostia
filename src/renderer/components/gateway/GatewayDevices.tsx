import type { Dict } from '@shared/app/dict'
import type { GatewayDevice, GatewayPushAvailability } from '@shared/gateway/gatewayApi'
import { PHONE_GRANTABLE_CAPS, type PhoneGrantableCap } from '@shared/gateway/phoneCapabilities'
import { useState } from 'react'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SettingsSubgroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
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
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { DATE_ONLY, formatDate } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { DevicePushRow } from './GatewayDevicePush'

const CAP_NEEDS: Partial<Record<PhoneGrantableCap, PhoneGrantableCap>> = {
  destructive: 'command',
}

export function capText(d: Dict): Record<PhoneGrantableCap, { label: string; desc: string }> {
  return {
    respond: { label: d.settings.remoteCapRespond, desc: d.settings.remoteCapRespondDesc },
    command: { label: d.settings.remoteCapCommand, desc: d.settings.remoteCapCommandDesc },
    input: { label: d.settings.remoteCapInput, desc: d.settings.remoteCapInputDesc },
    destructive: {
      label: d.settings.remoteCapDestructive,
      desc: d.settings.remoteCapDestructiveDesc,
    },
  }
}

function DeviceRow({
  device,
  push,
  refresh,
  onChange,
  onRevoke,
}: {
  device: GatewayDevice
  push: GatewayPushAvailability
  refresh: () => Promise<void>
  onChange: (cap: PhoneGrantableCap, granted: boolean) => void
  onRevoke: () => void
}): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const [asking, setAsking] = useState(false)
  const text = capText(d)
  return (
    <SettingsListRow
      title={<span className="font-medium">{device.name}</span>}
      meta={
        <span className="tabular-nums">
          {fmt(d.settings.remotePairedOn, {
            date: formatDate(Date.parse(device.createdAt), locale, DATE_ONLY),
          })}
        </span>
      }
      actions={
        <Button
          variant="ghost"
          size="sm"
          className="text-attn-fg hover:text-attn-fg"
          onClick={() => setAsking(true)}
          aria-label={fmt(d.settings.remoteRevokeFor, { name: device.name })}
        >
          {d.settings.remoteRevoke}
        </Button>
      }
      below={
        <>
          <fieldset aria-label={fmt(d.settings.remoteGrantsFor, { name: device.name })}>
            {PHONE_GRANTABLE_CAPS.map((cap) => {
              const needs = CAP_NEEDS[cap]
              const { label, desc } = text[cap]
              return (
                <ControlRow
                  key={cap}
                  label={label}
                  desc={
                    needs ? fmt(d.settings.remoteCapNeeds, { desc, cap: text[needs].label }) : desc
                  }
                >
                  <Switch
                    checked={device.caps.includes(cap)}
                    disabled={needs !== undefined && !device.caps.includes(needs)}
                    onCheckedChange={(v) => onChange(cap, v)}
                    aria-label={fmt(d.settings.remoteCapFor, { cap: label, name: device.name })}
                  />
                </ControlRow>
              )
            })}
          </fieldset>
          <DevicePushRow device={device} availability={push} refresh={refresh} />
          <AlertDialog open={asking} onOpenChange={setAsking}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {fmt(d.settings.remoteRevokeTitle, { name: device.name })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {fmt(d.settings.remoteRevokeBody, { name: device.name })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel size="sm">{d.settings.remoteCancel}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setAsking(false)
                    onRevoke()
                  }}
                >
                  {d.settings.remoteRevoke}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      }
    />
  )
}

export function DeviceList({
  devices,
  push,
  refresh,
}: {
  devices: GatewayDevice[]
  push: GatewayPushAvailability
  refresh: () => Promise<void>
}): JSX.Element {
  const d = useDict()
  const [confirmDevice, setConfirmDevice] = useState<GatewayDevice | null>(null)

  const onRevoke = async (deviceId: string): Promise<void> => {
    await window.ostia.gateway.revoke(deviceId)
    await refresh()
  }

  const setCap = async (deviceId: string, cap: PhoneGrantableCap, granted: boolean) => {
    await window.ostia.gateway.setCap(deviceId, cap, granted)
    await refresh()
  }

  const onCapChange = (device: GatewayDevice, cap: PhoneGrantableCap, granted: boolean): void => {
    if (cap === 'destructive' && granted) {
      setConfirmDevice(device)
      return
    }
    void setCap(device.deviceId, cap, granted)
  }

  const onConfirmDestructive = async (): Promise<void> => {
    const device = confirmDevice
    setConfirmDevice(null)
    if (device) await setCap(device.deviceId, 'destructive', true)
  }

  return (
    <>
      <SettingsSubgroup
        title={d.settings.remoteDevices}
        desc={devices.length > 0 ? d.settings.remoteGrantsDesc : undefined}
      />
      <SettingsList label={d.settings.remoteDevices} empty={d.settings.remoteNoDevices}>
        {devices.map((dev) => (
          <DeviceRow
            key={dev.deviceId}
            device={dev}
            push={push}
            refresh={refresh}
            onChange={(cap, v) => onCapChange(dev, cap, v)}
            onRevoke={() => void onRevoke(dev.deviceId)}
          />
        ))}
      </SettingsList>

      <Dialog
        open={confirmDevice !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDevice(null)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{d.settings.remoteDestructiveTitle}</DialogTitle>
            <DialogDescription>
              {fmt(d.settings.remoteDestructiveBody, { name: confirmDevice?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDevice(null)}>
              {d.settings.remoteCancel}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void onConfirmDestructive()}>
              {d.settings.remoteDestructiveConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
