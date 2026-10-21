import type { ServerApproval } from '@shared/server/serverApi'
import { useEffect, useState } from 'react'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { ageText } from './deviceAge'
import { type ServerErrorCode, serverErrorText } from './serverText'

const POLL_MS = 4000

export function ServerApprovals(): JSX.Element | null {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const [asks, setAsks] = useState<ServerApproval[]>([])
  const [denied, setDenied] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<ServerErrorCode | null>(null)

  useEffect(() => {
    let live = true
    const load = (): void => {
      void window.ostia.server.approvals().then((res) => {
        if (live && res.ok) setAsks(res.approvals)
      })
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  const approve = async (id: string): Promise<void> => {
    const res = await window.ostia.server.approve(id)
    setError(res.ok ? null : res.error)
    if (res.ok) setAsks((list) => list.filter((a) => a.id !== id))
  }

  const shown = asks.filter((a) => !denied.has(a.id))
  if (shown.length === 0) return null
  return (
    <>
      {shown.map((ask) => (
        <ControlRow
          key={ask.id}
          label={d.server.approvalLabel}
          desc={fmt(d.server.approvalAsks, {
            name: ask.deviceName,
            age: ageText(locale, ask.deviceCreatedAt),
          })}
          error={error ? serverErrorText(d, error) : null}
        >
          <Button variant="outline" size="sm" onClick={() => void approve(ask.id)}>
            {d.server.approvalApprove}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDenied((all) => new Set([...all, ask.id]))}
          >
            {d.server.approvalDeny}
          </Button>
        </ControlRow>
      ))}
    </>
  )
}
