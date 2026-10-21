import type { SyncAttention } from '@shared/profileSync/serverSync'
import type { ServerDevice } from '@shared/server/serverApi'
import { useCallback, useEffect, useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { refreshSyncAttention, useSyncAttentionStore } from '@/stores/server/syncAttentionStore'
import { ageText } from './deviceAge'
import { ServerLinkDevice } from './ServerLinkDevice'
import { type RemoveTarget, ServerRemoveDialog } from './ServerRemoveDialog'
import { serverErrorText } from './serverText'
import { syncServerErrorText } from './syncServerText'
import { useElevated } from './useElevated'
import { useSyncServerStatus } from './useSyncServerStatus'

const POLL_MS = 8000

type AskItem = Extract<SyncAttention, { kind: 'approval' }>

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
  const [askErrors, setAskErrors] = useState<Record<string, string | null>>({})
  const items = useSyncAttentionStore((st) => st.items)
  const hidden = useSyncAttentionStore((st) => st.hidden)
  const hide = useSyncAttentionStore((st) => st.hide)
  const asks = items.filter(
    (item): item is AskItem => item.kind === 'approval' && !hidden.has(item.id),
  )

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

  const markSeen = async (id: string): Promise<void> => {
    await window.ostia.server.markSeen(id)
    reload()
    void refreshSyncAttention()
  }

  const approve = async (ask: AskItem): Promise<void> => {
    const res = await window.ostia.server.approve(ask.approvalId)
    setAskErrors((all) => ({ ...all, [ask.id]: res.ok ? null : serverErrorText(d, res.error) }))
    void refreshSyncAttention()
  }

  const rowActions = (device: ServerDevice, ask: AskItem | undefined): JSX.Element | null => {
    if (ask) {
      return (
        <>
          <Button variant="outline" size="sm" onClick={() => void approve(ask)}>
            {d.server.approvalApprove}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => hide(ask.id)}>
            {d.server.approvalDeny}
          </Button>
        </>
      )
    }
    if (device.current) return null
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setRemoving({ id: device.id, name: device.name })}
      >
        {d.server.deviceRemove}
      </Button>
    )
  }

  const rowBelow = (device: ServerDevice, ask: AskItem | undefined): JSX.Element | null => {
    const askError = ask ? askErrors[ask.id] : null
    if (askError) return <Notice tone="error">{askError}</Notice>
    if (!device.isNew || device.current) return null
    return (
      <Notice
        actions={
          <Button variant="outline" size="sm" onClick={() => void markSeen(device.id)}>
            {d.server.newDeviceMine}
          </Button>
        }
      >
        {d.server.newDeviceWarning}
      </Notice>
    )
  }

  return (
    <>
      <SettingsList label={d.server.devicesLabel} empty={d.server.devicesEmpty}>
        {devices.map((device) => {
          const ask = asks.find((item) => item.deviceId === device.id)
          const age = ageText(locale, device.createdAt)
          return (
            <SettingsListRow
              key={device.id}
              title={device.name}
              meta={device.current ? d.server.deviceThis : undefined}
              detail={fmt(ask ? d.server.approvalAsks : d.server.deviceAdded, { age })}
              actions={rowActions(device, ask)}
              below={rowBelow(device, ask)}
            />
          )
        })}
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
