import type { SyncAttention } from '@shared/profileSync/serverSync'
import { type ReactNode, useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { refreshSyncAttention, useSyncAttentionStore } from '@/stores/server/syncAttentionStore'
import { ageText } from './deviceAge'
import { serverErrorText } from './serverText'
import { syncServerErrorText } from './syncServerText'

function AskCard({
  item,
  label,
  desc,
  approve,
  approveLabel,
  denyLabel,
}: {
  item: SyncAttention
  label: string
  desc: string
  approve: () => Promise<string | null>
  approveLabel: string
  denyLabel: string
}): JSX.Element {
  const hide = useSyncAttentionStore((s) => s.hide)
  const [error, setError] = useState<string | null>(null)
  const run = async (): Promise<void> => {
    setError(await approve())
    void refreshSyncAttention()
  }
  return (
    <ControlRow label={label} desc={desc} error={error}>
      <Button variant="outline" size="sm" onClick={() => void run()}>
        {approveLabel}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => hide(item.id)}>
        {denyLabel}
      </Button>
    </ControlRow>
  )
}

function card(
  item: SyncAttention,
  d: ReturnType<typeof useDict>,
  age: (at: number) => string,
): ReactNode {
  switch (item.kind) {
    case 'join':
      return (
        <AskCard
          key={item.id}
          item={item}
          label={d.server.joinLabel}
          desc={fmt(d.server.joinAsks, {
            name: item.name,
            age: age(item.createdAt),
            code: item.code,
          })}
          approveLabel={d.server.joinApprove}
          denyLabel={d.server.joinDeny}
          approve={async () => {
            const res = await window.ostia.syncServer.approveJoin(item.deviceId, item.code)
            return res.ok ? null : syncServerErrorText(d, res.error)
          }}
        />
      )
    case 'approval':
      return (
        <AskCard
          key={item.id}
          item={item}
          label={d.server.approvalLabel}
          desc={fmt(d.server.approvalAsks, { name: item.name, age: age(item.deviceCreatedAt) })}
          approveLabel={d.server.approvalApprove}
          denyLabel={d.server.approvalDeny}
          approve={async () => {
            const res = await window.ostia.server.approve(item.approvalId)
            return res.ok ? null : serverErrorText(d, res.error)
          }}
        />
      )
    case 'new-device':
      return (
        <Notice
          key={item.id}
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void window.ostia.server.markSeen(item.deviceId).then(refreshSyncAttention)
              }
            >
              {d.server.newDeviceMine}
            </Button>
          }
        >
          {fmt(d.server.newDeviceWarning, { name: item.name, age: age(item.createdAt) })}
        </Notice>
      )
    case 'changed':
      return (
        <Notice key={item.id}>
          {fmt(d.syncServer.changedDevices, { devices: item.names.join(', ') })}
        </Notice>
      )
  }
}

export function SyncAttentionCards(): JSX.Element | null {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const items = useSyncAttentionStore((s) => s.items)
  const hidden = useSyncAttentionStore((s) => s.hidden)
  const shown = items.filter((item) => !hidden.has(item.id))
  if (shown.length === 0) return null
  return <>{shown.map((item) => card(item, d, (at) => ageText(locale, at)))}</>
}
