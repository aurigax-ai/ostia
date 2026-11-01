import { CaretRightIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import type { GatewayDevice, GatewayPushAvailability } from '@shared/gateway/gatewayApi'
import { PHONE_GRANTABLE_CAPS, type PhoneGrantableCap } from '@shared/gateway/phoneCapabilities'
import { type JSX, useState } from 'react'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsList } from '@/components/settingsKit/SettingsList'
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
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'
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

function useDeviceMeta(device: GatewayDevice): string {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  return fmt(d.settings.remotePairedOn, {
    date: formatDate(Date.parse(device.createdAt), locale, DATE_ONLY),
  })
}

function DeviceCard({ device, onOpen }: { device: GatewayDevice; onOpen: () => void }) {
  const d = useDict()
  const text = capText(d)
  const meta = useDeviceMeta(device)
  const granted = PHONE_GRANTABLE_CAPS.filter((cap) => device.caps.includes(cap)).map(
    (cap) => text[cap].label,
  )
  const summary = device.push.enabled ? [...granted, d.settings.remotePush] : granted
  return (
    <li className="pb-2">
      <Item
        variant="outline"
        size="sm"
        render={<button type="button" />}
        aria-label={fmt(d.settings.remoteManageFor, { name: device.name })}
        className="rounded-md border-line px-3 py-2 text-left hover:bg-surface-2"
        onClick={onOpen}
      >
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle className="text-fg text-ui-base">
            {device.name}
            <span className="font-normal text-fg-muted text-ui-xs tabular-nums">{meta}</span>
          </ItemTitle>
          {summary.length > 0 ? (
            <ItemDescription className="text-fg-muted text-ui-sm">
              {summary.join(' · ')}
            </ItemDescription>
          ) : null}
        </ItemContent>
        <ItemActions>
          <CaretRightIcon className="text-fg-muted" />
        </ItemActions>
      </Item>
    </li>
  )
}

function DeviceDialog({
  device,
  push,
  refresh,
  onCap,
  onClose,
  onUnpair,
}: {
  device: GatewayDevice
  push: GatewayPushAvailability
  refresh: () => Promise<void>
  onCap: (cap: PhoneGrantableCap, granted: boolean) => void
  onClose: () => void
  onUnpair: () => void
}): JSX.Element {
  const d = useDict()
  const text = capText(d)
  const meta = useDeviceMeta(device)
  const [asking, setAsking] = useState(false)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{device.name}</DialogTitle>
          <DialogDescription>
            <span className="block">{meta}</span>
            <span className="block">{d.settings.remoteGrantsDesc}</span>
          </DialogDescription>
        </DialogHeader>
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
                  onCheckedChange={(v) => onCap(cap, v)}
                  aria-label={fmt(d.settings.remoteCapFor, { cap: label, name: device.name })}
                />
              </ControlRow>
            )
          })}
          <DevicePushRow device={device} availability={push} refresh={refresh} />
        </fieldset>
        <DialogFooter>
          <Button
            variant="destructive"
            size="sm"
            className="sm:mr-auto"
            onClick={() => setAsking(true)}
          >
            {d.settings.remoteUnpair}
          </Button>
          <Button size="sm" onClick={onClose}>
            {d.settings.remoteDone}
          </Button>
        </DialogFooter>
        <AlertDialog open={asking} onOpenChange={setAsking}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {fmt(d.settings.remoteUnpairTitle, { name: device.name })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {fmt(d.settings.remoteUnpairBody, { name: device.name })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel size="sm">{d.settings.remoteCancel}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                size="sm"
                onClick={() => {
                  setAsking(false)
                  onUnpair()
                }}
              >
                {d.settings.remoteUnpair}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
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
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirmDevice, setConfirmDevice] = useState<GatewayDevice | null>(null)
  const opened = devices.find((dev) => dev.deviceId === openId) ?? null

  const unpair = async (deviceId: string): Promise<void> => {
    setOpenId(null)
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
    <SettingsGroup title={d.settings.remoteDevices} desc={d.settings.remoteDevicesDesc}>
      <SettingsList label={d.settings.remoteDevices} empty={d.settings.remoteNoDevices}>
        {devices.map((dev) => (
          <DeviceCard key={dev.deviceId} device={dev} onOpen={() => setOpenId(dev.deviceId)} />
        ))}
      </SettingsList>
      {opened ? (
        <DeviceDialog
          device={opened}
          push={push}
          refresh={refresh}
          onCap={(cap, v) => onCapChange(opened, cap, v)}
          onClose={() => setOpenId(null)}
          onUnpair={() => void unpair(opened.deviceId)}
        />
      ) : null}
      <AlertDialog
        open={confirmDevice !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDevice(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{d.settings.remoteDestructiveTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {fmt(d.settings.remoteDestructiveBody, { name: confirmDevice?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">{d.settings.remoteCancel}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="sm"
              onClick={() => void onConfirmDestructive()}
            >
              {d.settings.remoteDestructiveConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  )
}
