import type { SyncAttention } from '@shared/profileSync/serverSync'
import { useState } from 'react'
import { MachineValue } from '@/components/common/MachineValue'
import { Notice } from '@/components/common/Notice'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { refreshSyncAttention, useSyncAttentionStore } from '@/stores/server/syncAttentionStore'
import { ageText } from './deviceAge'
import { syncServerErrorText } from './syncServerText'

type Join = Extract<SyncAttention, { kind: 'join' }>

export function SyncRequests(): JSX.Element | null {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const items = useSyncAttentionStore((s) => s.items)
  const hidden = useSyncAttentionStore((s) => s.hidden)
  const hide = useSyncAttentionStore((s) => s.hide)
  const [errors, setErrors] = useState<Record<string, string | null>>({})
  const shown = items.filter((item) => !hidden.has(item.id))
  const joins = shown.filter((item): item is Join => item.kind === 'join')

  const approve = async (join: Join): Promise<void> => {
    const res = await window.ostia.syncServer.approveJoin(join.deviceId, join.code)
    setErrors((all) => ({ ...all, [join.id]: res.ok ? null : syncServerErrorText(d, res.error) }))
    void refreshSyncAttention()
  }

  if (joins.length === 0) return null
  return (
    <SettingsGroup title={d.syncServer.requestsLabel}>
      <SettingsList label={d.syncServer.requestsLabel} empty="">
        {joins.map((join) => (
          <SettingsListRow
            key={join.id}
            title={join.name}
            detail={
              <>
                <div>{fmt(d.server.deviceAdded, { age: ageText(locale, join.createdAt) })}</div>
                <div>{fmt(d.server.joinCheck, { name: join.name })}</div>
                <div>
                  <MachineValue value={join.code} />
                </div>
              </>
            }
            actions={
              <>
                <Button variant="outline" size="sm" onClick={() => void approve(join)}>
                  {d.server.joinApprove}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => hide(join.id)}>
                  {d.server.joinDeny}
                </Button>
              </>
            }
            below={errors[join.id] ? <Notice tone="error">{errors[join.id]}</Notice> : null}
          />
        ))}
      </SettingsList>
    </SettingsGroup>
  )
}
