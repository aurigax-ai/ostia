import type { ServerDevice } from '@shared/server/serverApi'
import { useCallback, useEffect, useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { ageText } from './deviceAge'
import { ServerLinkDevice } from './ServerLinkDevice'
import { type RemoveTarget, ServerRemoveDialog } from './ServerRemoveDialog'
import { syncServerErrorText } from './syncServerText'
import { useElevated } from './useElevated'
import { useSyncServerStatus } from './useSyncServerStatus'

const POLL_MS = 8000

function useDevices(): [ServerDevice[], () => void] {
  const [devices, setDevices] = useState<ServerDevice[]>([])
  const load = useCallback((): void => {
    void window.ostia.server.devices().then((res) => {
      if (res.ok) setDevices(res.devices)
    })
  }, [])
  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    const off = window.ostia.server.onDevicesChanged(load)
    return () => {
      clearInterval(timer)
      off()
    }
  }, [load])
  return [devices, load]
}

export function ServerDevices(): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const [devices, reload] = useDevices()
  const [sync, setSync] = useSyncServerStatus()
  const elevated = useElevated()
  const [removing, setRemoving] = useState<RemoveTarget | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const remove = async (target: RemoveTarget, passphrase: string, recoveryKey: string) => {
    setError(null)
    const res = await elevated.run(() =>
      window.ostia.syncServer.removeDevice(target.id, passphrase, recoveryKey),
    )
    setSync(res.status)
    if (res.ok || res.removed) {
      setRemoving(null)
      const base = res.rotated ? d.server.removeDoneRotated : d.server.removeDone
      const skipped = res.unwrapped ?? []
      setNotice(
        skipped.length > 0
          ? `${base} ${fmt(d.server.removeUnwrapped, { names: skipped.join(', ') })}`
          : base,
      )
    }
    if (!res.ok) setError(syncServerErrorText(d, res.error))
    reload()
  }

  return (
    <>
      <ControlRow label={d.server.devicesLabel} desc={d.server.devicesDesc} />
      <SettingsList label={d.server.devicesLabel} empty={d.server.devicesEmpty}>
        {devices.map((device) => (
          <SettingsListRow
            key={device.id}
            title={device.current ? `${device.name} · ${d.server.deviceThis}` : device.name}
            detail={fmt(d.server.deviceAdded, { age: ageText(locale, device.createdAt) })}
            actions={
              device.current ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRemoving({ id: device.id, name: device.name })}
                >
                  {d.server.deviceRemove}
                </Button>
              )
            }
          />
        ))}
      </SettingsList>
      {notice ? <Notice tone="info">{notice}</Notice> : null}
      {error && removing === null ? <Notice tone="error">{error}</Notice> : null}
      {elevated.prompt}
      <ServerLinkDevice />
      <ServerRemoveDialog
        key={removing?.id ?? 'none'}
        target={removing}
        syncing={sync.state === 'ready'}
        error={error}
        onClose={() => {
          setRemoving(null)
          setError(null)
        }}
        onConfirm={(target, passphrase, recoveryKey) =>
          void remove(target, passphrase, recoveryKey)
        }
      />
    </>
  )
}
