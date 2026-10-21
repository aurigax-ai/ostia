import type { Dict } from '@shared/app/dict'
import type {
  GatewayDevice,
  GatewayPushAvailability,
  GatewaySetPushResult,
} from '@shared/gateway/gatewayApi'
import { useState } from 'react'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { Switch } from '@/components/ui/switch'
import { fmt, useDict } from '@/lib/app/useDict'

type PushError = Exclude<GatewaySetPushResult, { ok: true }>['error']

function unavailableText(d: Dict, reason: PushError | GatewayPushAvailability): string | null {
  if (reason === 'not-signed-in') return d.settings.remotePushNotSignedIn
  if (reason === 'server-push-off') return d.settings.remotePushServerOff
  if (reason === 'unreachable') return d.settings.remotePushUnreachable
  if (reason === 'needs-notify') return d.settings.remotePushNeedsNotify
  return null
}

function stateText(d: Dict, device: GatewayDevice, availability: GatewayPushAvailability): string {
  const unavailable = device.caps.includes('notify')
    ? unavailableText(d, availability)
    : d.settings.remotePushNeedsNotify
  if (unavailable && !device.push.enabled) return unavailable
  if (!device.push.enabled) return d.settings.remotePushDescOff
  if (unavailable) return unavailable
  return device.push.registered
    ? d.settings.remotePushDescRegistered
    : d.settings.remotePushDescWaiting
}

export function DevicePushRow({
  device,
  availability,
  refresh,
}: {
  device: GatewayDevice
  availability: GatewayPushAvailability
  refresh: () => Promise<void>
}): JSX.Element {
  const d = useDict()
  const [error, setError] = useState<string | null>(null)
  const blocked = !device.caps.includes('notify') || availability !== 'available'

  const onChange = async (enabled: boolean): Promise<void> => {
    const result = await window.ostia.gateway.setDevicePush(device.deviceId, enabled)
    setError(result.ok ? null : unavailableText(d, result.error))
    await refresh()
  }

  return (
    <ControlRow
      label={d.settings.remotePush}
      desc={stateText(d, device, availability)}
      error={error}
    >
      <Switch
        checked={device.push.enabled}
        disabled={blocked && !device.push.enabled}
        onCheckedChange={(v) => void onChange(v)}
        aria-label={fmt(d.settings.remotePushFor, { name: device.name })}
      />
    </ControlRow>
  )
}
