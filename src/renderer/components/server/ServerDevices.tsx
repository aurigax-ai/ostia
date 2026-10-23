import type { SyncAttention } from '@shared/profileSync/serverSync'
import type { ServerDevice } from '@shared/server/serverApi'
import { useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { RowRemoveButton } from '@/components/settingsKit/RowRemoveButton'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { Button } from '@/components/ui/button'
import { formatDate, SHORT_DATE_TIME } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { refreshSyncAttention, useSyncAttentionStore } from '@/stores/server/syncAttentionStore'
import { ageText } from './deviceAge'
import { ServerLinkDevice } from './ServerLinkDevice'
import { type RemoveTarget, ServerRemoveDialog } from './ServerRemoveDialog'
import { serverErrorText } from './serverText'
import { syncServerErrorText } from './syncServerText'
import { useElevated } from './useElevated'
import type { ServerDevicesState } from './useServerDevices'
import { useSyncServerStatus } from './useSyncServerStatus'

const REMOVAL_NOTICE_MS = 14 * 24 * 60 * 60 * 1000

const removalSoon = (device: ServerDevice): boolean =>
  !device.current && device.removeAt > 0 && device.removeAt - Date.now() <= REMOVAL_NOTICE_MS

type AskItem = Extract<SyncAttention, { kind: 'approval' }>
type ChangedItem = Extract<SyncAttention, { kind: 'changed' }>

export function ServerDevices({
  state: { devices, loaded, reload },
  onLeave,
}: {
  state: ServerDevicesState
  onLeave: () => void
}): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
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
  const changes = items.filter((item): item is ChangedItem => item.kind === 'changed')

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

  const approve = async (ask: AskItem): Promise<void> => {
    const res = await window.ostia.server.approve(ask.approvalId)
    setAskErrors((all) => ({ ...all, [ask.id]: res.ok ? null : serverErrorText(d, res.error) }))
    void refreshSyncAttention()
  }

  const askActions = (ask: AskItem): JSX.Element => (
    <>
      <Button variant="outline" size="sm" onClick={() => void approve(ask)}>
        {d.server.approvalApprove}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => hide(ask.id)}>
        {d.server.approvalDeny}
      </Button>
    </>
  )

  const rowActions = (device: ServerDevice, ask: AskItem | undefined): JSX.Element => {
    if (ask) return askActions(ask)
    const remove = device.current
      ? onLeave
      : () => setRemoving({ id: device.id, name: device.name })
    return <RowRemoveButton label={d.server.deviceRemove} onClick={remove} />
  }

  const askDetail = (line: string): JSX.Element => (
    <>
      <div>{line}</div>
      <div>{d.server.approvalSafety}</div>
    </>
  )

  const rowBelow = (ask: AskItem | undefined): JSX.Element | null => {
    const askError = ask ? askErrors[ask.id] : null
    return askError ? <Notice tone="error">{askError}</Notice> : null
  }

  return (
    <>
      <SettingsList label={d.server.devicesLabel} empty={d.server.devicesEmpty}>
        {devices.map((device) => {
          const ask = asks.find((item) => item.deviceId === device.id)
          const changed = changes.find((item) => item.deviceId === device.id)
          const detail = ask
            ? askDetail(fmt(d.server.approvalAsks, { age: ageText(locale, device.createdAt) }))
            : changed
              ? fmt(d.server.deviceChanged, {
                  time: formatDate(changed.until, locale, SHORT_DATE_TIME),
                })
              : removalSoon(device)
                ? fmt(d.server.deviceRemoveAt, {
                    time: formatDate(device.removeAt, locale, SHORT_DATE_TIME),
                  })
                : fmt(d.server.deviceAdded, { age: ageText(locale, device.createdAt) })
          return (
            <SettingsListRow
              key={device.id}
              title={device.name}
              meta={
                device.current
                  ? d.server.deviceThis
                  : changed
                    ? d.server.deviceChangedBadge
                    : undefined
              }
              detail={detail}
              actions={rowActions(device, ask)}
              below={rowBelow(ask)}
            />
          )
        })}
        {(loaded ? asks : [])
          .filter((ask) => !devices.some((device) => device.id === ask.deviceId))
          .map((ask) => (
            <SettingsListRow
              key={ask.id}
              title={ask.name}
              detail={askDetail(d.server.approvalAsksNow)}
              actions={askActions(ask)}
              below={rowBelow(ask)}
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
