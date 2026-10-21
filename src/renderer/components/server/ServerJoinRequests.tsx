import type { ServerJoinRequest } from '@shared/profileSync/serverSync'
import { useState } from 'react'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { ageText } from './deviceAge'
import { syncServerErrorText } from './syncServerText'
import { useSyncServerStatus } from './useSyncServerStatus'

export function ServerJoinRequests(): JSX.Element | null {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const [status, setStatus] = useSyncServerStatus()
  const [denied, setDenied] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const approve = async (join: ServerJoinRequest): Promise<void> => {
    const res = await window.ostia.syncServer.approveJoin(join.deviceId)
    setStatus(res.status)
    setError(res.ok ? null : syncServerErrorText(d, res.error))
  }

  const shown = status.joins.filter((j) => !denied.has(j.deviceId))
  if (shown.length === 0) return null
  return (
    <>
      {shown.map((join) => (
        <ControlRow
          key={join.deviceId}
          label={d.server.joinLabel}
          desc={fmt(d.server.joinAsks, {
            name: join.name,
            age: ageText(locale, join.createdAt),
            code: join.code,
          })}
          error={error}
        >
          <Button variant="outline" size="sm" onClick={() => void approve(join)}>
            {d.server.joinApprove}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDenied((all) => new Set([...all, join.deviceId]))}
          >
            {d.server.joinDeny}
          </Button>
        </ControlRow>
      ))}
    </>
  )
}
